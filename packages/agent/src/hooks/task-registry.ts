/**
 * HookTaskRegistry - In-memory registry for background hook tasks.
 *
 * Mirrors BashTaskRegistry (session/bash-task-registry.ts) but is scoped to
 * hooks: an `async: true` hook is spawned detached, its stdout/stderr stream
 * into an on-disk output file, and the task stays registered here until it
 * settles. The registry drives two consumers:
 *
 * - completion callback: `asyncRewake: true` tasks deliver their result via
 *   a mailbox background_notification (./notify.ts) — the hook result lands
 *   in the session message stream like any background bash task.
 * - renderer snapshot: `onAnyChange` pushes a throttled `hook_task:update`
 *   snapshot to the main process so the Settings → Hooks page can show
 *   running / finished background hooks.
 *
 * Lifecycle: terminal tasks are kept ~5 minutes for late reads, then
 * evicted. `finalizeAll` kills every still-running task (session teardown).
 */

import { readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type HookTaskStatus = 'running' | 'completed' | 'killed' | 'error';

export interface HookBackgroundTask {
  id: string;
  /** Hook event that spawned this task (e.g. 'UserPromptSubmit'). */
  event: string;
  /** Hook command type ('command' | 'process'). */
  hookType: string;
  /** Human-readable command line for display. */
  command: string;
  /** Parent session id (from the hook input) — used for notifications. */
  sessionId: string;
  /** Whether the completion should wake the model (asyncRewake). */
  rewake: boolean;
  pid: number | null;
  /** Full stdout+stderr log file path on disk. */
  outputFile: string;
  status: HookTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
}

export type AnyChangeListener = () => void;

/** Terminal tasks are kept this long so late UI/reads still see the result. */
const TERMINAL_TASK_TTL_MS = 5 * 60 * 1000;

export class HookTaskRegistry {
  private tasks = new Map<string, HookBackgroundTask>();
  private anyChangeListeners = new Set<AnyChangeListener>();

  register(task: HookBackgroundTask): void {
    this.tasks.set(task.id, { ...task });
    this.notifyAnyChange();
  }

  /** Patch a running task's fields and notify. */
  update(id: string, patch: Partial<HookBackgroundTask>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, patch);
    this.notifyAnyChange();
  }

  markCompleted(id: string, exitCode: number, error?: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.status = exitCode === 0 && !error ? 'completed' : 'error';
    task.endTime = Date.now();
    task.exitCode = exitCode;
    if (error) task.error = error;
    this.notifyAnyChange();
    this.scheduleCleanup(id);
  }

  markKilled(id: string, reason: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.status = 'killed';
    task.endTime = Date.now();
    task.error = reason;
    this.notifyAnyChange();
    this.scheduleCleanup(id);
  }

  getTask(id: string): HookBackgroundTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): HookBackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  listRunningTasks(): HookBackgroundTask[] {
    return this.tasks.size === 0
      ? []
      : Array.from(this.tasks.values()).filter((t) => t.status === 'running');
  }

  /**
   * Read the tail of a background hook's output file.
   * Returns null when the file does not exist.
   */
  readOutput(id: string, maxBytes: number = 100_000): { text: string; totalBytes: number } | null {
    const task = this.tasks.get(id);
    if (!task || !task.outputFile) return null;
    try {
      const stat = statSync(task.outputFile);
      if (stat.size === 0) return { text: '', totalBytes: 0 };
      const buf = readFileSync(task.outputFile, 'utf-8');
      if (buf.length > maxBytes) {
        return {
          text: `(truncated - ${stat.size} bytes total)\n\n` + buf.slice(buf.length - maxBytes),
          totalBytes: stat.size,
        };
      }
      return { text: buf, totalBytes: stat.size };
    } catch {
      return null;
    }
  }

  /** Kill a running background hook (taskkill /F /T on Windows). */
  async stopTask(id: string): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(id);
    if (!task) return { success: false, message: `Task ${id} not found` };
    if (task.status !== 'running') {
      return { success: false, message: `Task ${id} is not running (status: ${task.status})` };
    }
    try {
      if (task.pid !== null && task.pid > 0) {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /F /T /PID ${task.pid}`, { windowsHide: true });
        } else {
          process.kill(task.pid, 'SIGKILL');
        }
      }
      this.markKilled(id, 'Stopped');
      return { success: true, message: `Task ${id} stopped` };
    } catch (err) {
      this.markKilled(id, `Stop failed: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, message: `Failed to stop task ${id}` };
    }
  }

  /** Kill every still-running task (session teardown / process shutdown). */
  async finalizeAll(reason: string): Promise<void> {
    const running = this.listRunningTasks();
    await Promise.all(
      running.map(async (task) => {
        try {
          await this.stopTask(task.id);
        } catch {
          // Best-effort — the process may already be gone.
        }
        this.markKilled(task.id, reason);
      }),
    );
  }

  onAnyChange(listener: AnyChangeListener): () => void {
    this.anyChangeListeners.add(listener);
    return () => this.anyChangeListeners.delete(listener);
  }

  /** Test helper: drop every task. */
  clear(): void {
    this.tasks.clear();
    this.notifyAnyChange();
  }

  private scheduleCleanup(id: string): void {
    setTimeout(() => {
      this.tasks.delete(id);
      this.notifyAnyChange();
    }, TERMINAL_TASK_TTL_MS).unref();
  }

  private notifyAnyChange(): void {
    for (const listener of this.anyChangeListeners) {
      try {
        listener();
      } catch {
        // Listener failures must never break the registry.
      }
    }
  }
}

/** Process-wide singleton — the agent process holds one registry. */
export const hookTaskRegistry = new HookTaskRegistry();
