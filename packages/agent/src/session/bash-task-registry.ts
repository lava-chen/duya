/**
 * BashTaskRegistry - Lightweight in-memory registry for background bash tasks.
 *
 * Tracks background/bash commands that have been detached from foreground
 * execution. Provides querying, output reading, and lifecycle management.
 */

import { readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type BashTaskStatus = 'running' | 'completed' | 'killed' | 'disk_limit' | 'error';

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
}

export type ProgressListener = (task: BashBackgroundTask) => void;

export class BashTaskRegistry {
  private tasks = new Map<string, BashBackgroundTask>();
  private listeners = new Map<string, Set<ProgressListener>>();

  register(task: BashBackgroundTask): void {
    this.tasks.set(task.id, { ...task });
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
  }

  markKilled(taskId: string, reason: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'killed';
    task.endTime = Date.now();
    task.error = reason;

    this.tasks.set(taskId, task);
    this.notifyListeners(taskId, task);
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
    }
    return existed;
  }

  /**
   * Read the tail of a background task's output file.
   * Returns null if file doesn't exist.
   */
  readOutput(taskId: string, maxBytes: number = 100_000): { text: string; totalBytes: number } | null {
    const task = this.tasks.get(taskId);
    if (!task || !task.outputFile) return null;

    try {
      const stat = statSync(task.outputFile);
      if (stat.size === 0) return { text: '', totalBytes: 0 };

      const readStart = Math.max(0, stat.size - maxBytes);
      const buf = readFileSync(task.outputFile, { encoding: 'utf-8' });

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

  /**
   * Kill a background task by PID. On Windows uses taskkill /F /T.
   */
  async stopTask(taskId: string): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, message: `Task ${taskId} not found` };
    }

    if (task.status !== 'running') {
      return { success: false, message: `Task ${taskId} is not running (status: ${task.status})` };
    }

    try {
      if (process.platform === 'win32') {
        await execAsync(`taskkill /F /T /PID ${task.pid}`, { windowsHide: true });
      } else {
        process.kill(task.pid, 'SIGKILL');
      }

      this.markKilled(taskId, 'Stopped by user');
      return { success: true, message: `Task ${taskId} stopped` };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found') || msg.includes('no such process')) {
        // Process already gone
        this.markCompleted(taskId, -1, 'Process already exited');
        return { success: true, message: `Task ${taskId} process was already gone` };
      }
      return { success: false, message: `Failed to stop task: ${msg}` };
    }
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

  private notifyListeners(taskId: string, task: BashBackgroundTask): void {
    const taskListeners = this.listeners.get(taskId);
    if (taskListeners) {
      for (const listener of taskListeners) {
        try { listener(task); } catch { /* mute */ }
      }
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

export function getBashTaskRegistry(): BashTaskRegistry {
  if (!_registry) {
    _registry = new BashTaskRegistry();
  }
  return _registry;
}

export function resetBashTaskRegistry(): void {
  _registry = null;
}