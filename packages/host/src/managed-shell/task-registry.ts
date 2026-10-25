/**
 * BashTaskRegistry - Lightweight in-memory registry for background bash tasks.
 *
 * Tracks background/bash commands that have been detached from foreground
 * execution. Provides querying, output reading, and lifecycle management.
 *
 * Durability: every state mutation is also persisted via {@link BashTaskStore}
 * (write-through). On startup, the owning Host worker should call
 * {@link initializeBashTaskRegistryFromStore} to rehydrate from disk so
 * previously-running tasks are recovered (with liveness reconciliation:
 * tasks whose PID is no longer alive are marked `lost`).
 */

import { readFileSync, statSync } from 'fs';
import { killProcessTree } from './process-tree-kill.js';
import { getBashTaskStore } from './task-store.js';

export type BashTaskStatus = 'running' | 'completed' | 'killed' | 'disk_limit' | 'error' | 'lost';

export interface BashTaskProgress {
  bytes: number;
  pid: number | null;
  elapsed: number;
  timestamp: number;
}

export interface BashBackgroundTask {
  id: string;
  pid: number;
  outputFile: string;
  command: string;
  status: BashTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
  lastProgress?: BashTaskProgress;
  /**
   * Set when a foreground call yielded the command to the background instead of
   * waiting for it (soft-yield auto-promotion). The process is NOT restarted —
   * only the wait ended — so PID/outputFile stay valid.
   */
  autoPromoted?: boolean;
  /** The foreground timeout the call was released from, when autoPromoted. */
  foregroundTimeoutMs?: number;
}

export type ProgressListener = (task: BashBackgroundTask) => void;
/** Global listener receives a snapshot of all tasks on any change. */
export type AnyChangeListener = (tasks: BashBackgroundTask[]) => void;

export interface OutputTail {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/**
 * Read at most `maxBytes` from the end of an output file.
 *
 * Returns null when the file cannot be read (missing, permissions); an empty
 * file is a real answer (`text: ''`), not a missing one. The `truncated` flag
 * is what lets a caller decide how to say "this is the tail", instead of every
 * caller inventing its own prefix.
 */
export function readOutputTail(outputFile: string, maxBytes: number): OutputTail | null {
  if (outputFile === '') return null;
  try {
    const stat = statSync(outputFile);
    if (stat.size === 0) return { text: '', totalBytes: 0, truncated: false };

    const buf = readFileSync(outputFile, { encoding: 'utf-8' });
    if (buf.length > maxBytes) {
      return { text: buf.slice(buf.length - maxBytes), totalBytes: stat.size, truncated: true };
    }
    return { text: buf, totalBytes: stat.size, truncated: false };
  } catch {
    return null;
  }
}

export class BashTaskRegistry {
  private readonly store: Pick<ReturnType<typeof getBashTaskStore>, 'persist' | 'rehydrate'>;
  private readonly killTree: typeof killProcessTree;
  private tasks = new Map<string, BashBackgroundTask>();
  private listeners = new Map<string, Set<ProgressListener>>();
  private anyChangeListeners = new Set<AnyChangeListener>();
  private rehydrated = false;

  constructor(options: {
    store?: Pick<ReturnType<typeof getBashTaskStore>, 'persist' | 'rehydrate'>;
    dataRoot?: string;
    killTree?: typeof killProcessTree;
  } = {}) {
    this.store = options.store ?? getBashTaskStore(
      options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot },
    );
    this.killTree = options.killTree ?? killProcessTree;
  }

  /**
   * Schedule a coalesced write to the durability store. Fire-and-forget
   * so the hot path is not blocked on filesystem I/O — write errors are
   * logged by the store and never bubble up to the caller.
   */
  private schedulePersist(): void {
    void this.store.persist(this.listTasks());
  }

  /**
   * Replace a task entry, mutating the underlying Map so iteration order
   * is preserved. Mutators always go through this helper so the persisted
   * snapshot never observes a partial state.
   */
  private upsert(task: BashBackgroundTask): void {
    this.tasks.set(task.id, task);
    this.schedulePersist();
  }

  register(task: BashBackgroundTask): void {
    this.tasks.set(task.id, { ...task });
    this.notifyAnyChange();
    this.schedulePersist();
  }

  updateProgress(taskId: string, progress: BashTaskProgress): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.lastProgress = {
      bytes: progress.bytes,
      pid: progress.pid,
      elapsed: progress.elapsed,
      timestamp: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.notifyListeners(taskId, task);
    this.notifyAnyChange();
    this.schedulePersist();
  }

  markCompleted(taskId: string, exitCode: number, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = exitCode === 0 && !error ? 'completed' : 'error';
    task.endTime = Date.now();
    task.exitCode = exitCode;
    if (error) task.error = error;

    this.tasks.set(taskId, task);
    this.notifyListeners(taskId, task);
    this.notifyAnyChange();
    this.schedulePersist();
    // Terminal tasks are kept briefly so the UI/agent can read the final
    // status, then evicted to bound memory growth of the tasks Map.
    this.scheduleCleanup(taskId);
  }

  markKilled(taskId: string, reason: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'killed';
    task.endTime = Date.now();
    task.error = reason;

    this.tasks.set(taskId, task);
    this.notifyListeners(taskId, task);
    this.notifyAnyChange();
    this.schedulePersist();
    this.scheduleCleanup(taskId);
  }

  /**
   * Mark a still-running task as auto-promoted: a foreground tool call stopped
   * waiting for it after the soft-yield window and handed the task id back to
   * the model. Purely observational — the child process keeps running.
   */
  markAutoPromoted(taskId: string, foregroundTimeoutMs?: number | null): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    task.autoPromoted = true;
    if (typeof foregroundTimeoutMs === 'number') {
      task.foregroundTimeoutMs = foregroundTimeoutMs;
    }

    this.tasks.set(taskId, task);
    this.notifyListeners(taskId, task);
    this.notifyAnyChange();
    this.schedulePersist();
  }

  /**
   * Auto-remove a terminal task after a delay. Keeps the entry around long
   * enough for late `task_output` queries, then frees the slot so the
   * tasks Map does not grow unbounded over a long session. removeTask is
   * idempotent, so a manual removal before the timer fires is safe.
   */
  private scheduleCleanup(taskId: string): void {
    setTimeout(() => {
      this.removeTask(taskId);
    }, 5 * 60 * 1000);
  }

  getTask(taskId: string): BashBackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): BashBackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  listRunningTasks(): BashBackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running');
  }

  removeTask(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    if (existed) {
      this.listeners.delete(taskId);
      this.notifyAnyChange();
      this.schedulePersist();
    }
    return existed;
  }

  /**
   * Rehydrate the in-memory map from the durability store. Intended to be
   * called once per Host worker on startup. Tasks whose PID is no longer
   * alive are left as `running` here — the store reconciles them before
   * they reach the registry. Idempotent: subsequent calls are no-ops once
   * {@link rehydrated} flips to `true`.
   */
  async rehydrateFromStore(): Promise<void> {
    if (this.rehydrated) return;
    this.rehydrated = true;
    const tasks = await this.store.rehydrate();
    for (const task of tasks) {
      // Don't clobber anything added since this promise started — register
      // only if we don't already have an entry.
      if (!this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
    }
    this.notifyAnyChange();
  }

  /**
   * Test-only: reset the rehydrated flag so {@link rehydrateFromStore} can
   * be called again. Not used in production.
   */
  resetForTest(): void {
    this.rehydrated = false;
    this.tasks.clear();
    this.listeners.clear();
    this.anyChangeListeners.clear();
  }

  /**
   * Read the tail of a background task's output file.
   * Returns null if file doesn't exist.
   */
  readOutput(taskId: string, maxBytes: number = 100_000): { text: string; totalBytes: number } | null {
    const task = this.tasks.get(taskId);
    if (!task || !task.outputFile) return null;

    const tail = readOutputTail(task.outputFile, maxBytes);
    if (tail === null) return null;
    return {
      // The registry's callers (agent tools) get a note in the text itself so
      // a clipped read does not look like a command that printed nothing.
      text: tail.truncated ? `(truncated - ${tail.totalBytes} bytes total)\n\n` + tail.text : tail.text,
      totalBytes: tail.totalBytes,
    };
  }

  /**
   * Kill a background task's whole process tree via killProcessTree —
   * `taskkill /T` on Windows, pgid SIGTERM→SIGKILL escalation on Unix. A
   * bare `process.kill(pid)` would orphan bash's grandchildren.
   */
  async stopTask(taskId: string): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, message: `Task ${taskId} not found` };
    }

    if (task.status !== 'running') {
      return { success: false, message: `Task ${taskId} is not running (status: ${task.status})` };
    }

    if (!this.isProcessAlive(task.pid)) {
      // Process is already gone; treat as a completed run rather than a kill.
      this.markCompleted(taskId, -1, 'Process already exited');
      return { success: true, message: `Task ${taskId} process was already gone` };
    }

    await this.killTree(task.pid);
    this.markKilled(taskId, 'Stopped by user');
    return { success: true, message: `Task ${taskId} stopped` };
  }

  /**
   * Check if a PID is still alive.
   */
  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the running status of all tasks by checking PID liveness.
   * Auto-marks dead tasks as completed.
   */
  refreshLiveness(): void {
    for (const [, task] of this.tasks) {
      if (task.status === 'running' && !this.isProcessAlive(task.pid)) {
        this.markCompleted(task.id, -1, 'Process exited (no exit code available)');
      }
    }
  }

  /** Subscribe to progress updates for a specific task */
  onProgress(taskId: string, listener: ProgressListener): () => void {
    if (!this.listeners.has(taskId)) {
      this.listeners.set(taskId, new Set());
    }
    this.listeners.get(taskId)!.add(listener);

    return () => {
      this.listeners.get(taskId)?.delete(listener);
    };
  }

  /**
   * Subscribe to any-change events. The listener receives a snapshot of
   * all tasks on every register/update/complete/kill/remove. Used by the
   * Host worker to publish task status through its event transport. Returns
   * an unsubscribe function.
   */
  onAnyChange(listener: AnyChangeListener): () => void {
    this.anyChangeListeners.add(listener);
    return () => {
      this.anyChangeListeners.delete(listener);
    };
  }

  private notifyListeners(taskId: string, task: BashBackgroundTask): void {
    const taskListeners = this.listeners.get(taskId);
    if (taskListeners) {
      for (const listener of taskListeners) {
        try { listener(task); } catch { /* mute */ }
      }
    }
  }

  private notifyAnyChange(): void {
    if (this.anyChangeListeners.size === 0) return;
    const snapshot = this.listTasks();
    for (const listener of this.anyChangeListeners) {
      try { listener(snapshot); } catch { /* mute */ }
    }
  }

  /** Number of running background tasks */
  get runningCount(): number {
    return this.listRunningTasks().length;
  }

  /** Total number of registered tasks */
  get count(): number {
    return this.tasks.size;
  }
}

/** Session-scoped singleton */
let _registry: BashTaskRegistry | null = null;

export function getBashTaskRegistry(options: {
  dataRoot?: string;
  killTree?: typeof killProcessTree;
} = {}): BashTaskRegistry {
  if (!_registry) {
    _registry = new BashTaskRegistry(options);
  }
  return _registry;
}

export function resetBashTaskRegistry(): void {
  _registry = null;
}
