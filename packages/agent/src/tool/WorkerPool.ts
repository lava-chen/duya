/**
 * WorkerPool.ts - Pool of long-running tool workers
 *
 * Manages worker processes for tools that need streaming output
 * or long-running execution. Workers are reused to avoid process
 * spawn overhead.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getBashTaskRegistry } from '../session/bash-task-registry.js';

const execAsync = promisify(exec);

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the correct path to BashWorker.js
 * In dev mode: __dirname/tool/BashTool/BashWorker.js
 * In packaged app: need to find agent directory instead of agent-bundle
 */
function resolveBashWorkerPath(): string {
  // First try the default path (works in dev mode)
  const defaultPath = path.join(__dirname, 'BashTool', 'BashWorker.js');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  // In packaged app, we might be in agent-bundle but BashWorker is in agent
  // Try to find the agent directory
  const possiblePaths = [
    // If we're in agent-bundle, look for agent at same level
    path.join(__dirname, '..', 'agent', 'tool', 'BashTool', 'BashWorker.js'),
    // If we're in agent-bundle/tool, look for agent/tool
    path.join(__dirname, '..', '..', 'agent', 'tool', 'BashTool', 'BashWorker.js'),
    // Try resources/agent directly
    path.join(process.cwd(), 'resources', 'agent', 'tool', 'BashTool', 'BashWorker.js'),
    // Try relative to execPath (Electron packaged app)
    path.join(path.dirname(process.execPath), 'resources', 'agent', 'tool', 'BashTool', 'BashWorker.js'),
  ];

  for (const tryPath of possiblePaths) {
    if (fs.existsSync(tryPath)) {
      console.log(`[WorkerPool] Found BashWorker at: ${tryPath}`);
      return tryPath;
    }
  }

  // Fallback to default path (will fail with useful error message)
  console.warn(`[WorkerPool] Could not find BashWorker.js, falling back to: ${defaultPath}`);
  return defaultPath;
}

export interface WorkerTask {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory?: string;
  abortController: AbortController;
  timeoutMs?: number;
}

export interface WorkerResult {
  taskId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  exitCode?: number;
  outputFile?: string;
  backgrounded?: boolean;
  pid?: number;
  // Streaming events - called for each output chunk
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
  onProgress?: (percent: number, stage: string) => void;
}

// Extended task interface with output callback
export interface WorkerTaskExtended extends WorkerTask {
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

interface ActiveWorker {
  id: string;
  process: ChildProcess;
  currentTask: WorkerTask | null;
  taskQueue: WorkerTask[];
  isIdle: boolean;
  lastUsed: number;
  ready: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
}

export class WorkerPool {
  private workers: Map<string, ActiveWorker> = new Map();
  private maxWorkers: number;
  private workerTimeoutMs: number;
  private workerStartupTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private workerScriptPath: string;

  constructor(options: {
    maxWorkers?: number;
    workerTimeoutMs?: number;
    workerStartupTimeoutMs?: number;
    workerScriptPath?: string;
  } = {}) {
    this.maxWorkers = options.maxWorkers ?? 4;
    this.workerTimeoutMs = options.workerTimeoutMs ?? 3600000; // 1h default
    this.workerStartupTimeoutMs = options.workerStartupTimeoutMs ?? 10000; // 10s default
    this.workerScriptPath =
      options.workerScriptPath ??
      resolveBashWorkerPath();
  }

  /**
   * Execute a task on an available worker
   */
  async executeTask(task: WorkerTaskExtended): Promise<WorkerResult> {
    // Find an idle worker or create a new one
    let worker = this.findIdleWorker();

    if (!worker && this.workers.size < this.maxWorkers) {
      worker = this.createWorker();
    }

    if (!worker) {
      // All workers busy, queue the task
      return this.queueTask(task);
    }

    try {
      await this.ensureWorkerReady(worker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WorkerPool] Worker not ready, cannot execute task', {
        workerId: worker.id,
        taskId: task.id,
        toolName: task.toolName,
        error: message,
      });
      return {
        taskId: task.id,
        success: false,
        error: `Worker startup failed: ${message}`,
      };
    }

    return this.runTaskOnWorker(worker, task);
  }

  /**
   * Find an idle worker
   */
  private findIdleWorker(): ActiveWorker | undefined {
    for (const worker of this.workers.values()) {
      if (worker.isIdle && !worker.currentTask) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Create a new worker process
   */
  private createWorker(): ActiveWorker {
    const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Determine the Node.js runtime to use
    // In Electron packaged app, use process.execPath (Electron executable)
    // which can run Node.js scripts. In dev mode, use system 'node'.
    const isPackaged = process.env.NODE_ENV === 'production' || 
                       process.execPath.includes('electron') ||
                       !process.execPath.endsWith('node.exe');
    const runtime = isPackaged ? process.execPath : 'node';
    
    console.log(`[WorkerPool] Spawning worker with runtime: ${runtime}`, {
      isPackaged,
      execPath: process.execPath,
      workerScript: this.workerScriptPath,
    });

    const proc = spawn(runtime, [this.workerScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const worker: ActiveWorker = {
      id: workerId,
      process: proc,
      currentTask: null,
      taskQueue: [],
      isIdle: true,
      lastUsed: Date.now(),
      ready: false,
      readyPromise,
      resolveReady,
      rejectReady,
    };

    const startupTimeout = setTimeout(() => {
      if (!worker.ready) {
        const err = new Error(`Worker did not send ready within ${this.workerStartupTimeoutMs}ms`);
        worker.rejectReady(err);
        console.error(`[WorkerPool] Worker ${workerId} startup timeout`, {
          scriptPath: this.workerScriptPath,
        });
      }
    }, this.workerStartupTimeoutMs);

    proc.on('message', (msg: { type?: string; [key: string]: unknown }) => {
      if (msg?.type === 'ready' && !worker.ready) {
        worker.ready = true;
        clearTimeout(startupTimeout);
        worker.resolveReady();
        console.log(`[WorkerPool] Worker ${workerId} ready`, {
          pid: proc.pid,
        });
      }
    });

    proc.on('exit', (code) => {
      console.log(`[WorkerPool] Worker ${workerId} exited with code ${code}`);
      clearTimeout(startupTimeout);
      if (!worker.ready) {
        worker.rejectReady(new Error(`Worker exited before ready (code=${code})`));
      }
      this.workers.delete(workerId);
    });

    proc.on('error', (err) => {
      console.error(`[WorkerPool] Worker ${workerId} error:`, err);
      clearTimeout(startupTimeout);
      if (!worker.ready) {
        worker.rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
      this.workers.delete(workerId);
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.log(`[WorkerPool:${workerId}] stdout: ${text}`);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[WorkerPool:${workerId}] stderr: ${text}`);
      }
    });

    this.workers.set(workerId, worker);
    console.log(`[WorkerPool] Created new worker: ${workerId}`);

    return worker;
  }

  private async ensureWorkerReady(worker: ActiveWorker): Promise<void> {
    if (worker.ready) return;
    await worker.readyPromise;
  }

  /**
   * Queue a task when no workers are available
   */
  private queueTask(task: WorkerTaskExtended): Promise<WorkerResult> {
    return new Promise((resolve) => {
      // Find worker with smallest queue
      let targetWorker: ActiveWorker | undefined;
      let minQueue = Infinity;

      for (const worker of this.workers.values()) {
        if (worker.taskQueue.length < minQueue) {
          minQueue = worker.taskQueue.length;
          targetWorker = worker;
        }
      }

      if (!targetWorker) {
        // No workers available at all
        resolve({
          taskId: task.id,
          success: false,
          error: 'No workers available and pool is full',
        });
        return;
      }

      // Add to queue
      targetWorker.taskQueue.push(task as WorkerTask);

      // Monitor for completion
      const checkComplete = setInterval(() => {
        const worker = this.workers.get(targetWorker!.process.pid?.toString() ?? '');
        if (!worker || worker.currentTask?.id === task.id) {
          clearInterval(checkComplete);
        } else {
          clearInterval(checkComplete);
          // Re-queue or fail
          resolve({
            taskId: task.id,
            success: false,
            error: 'Task was not completed',
          });
        }
      }, 1000);
    });
  }

  /**
   * Run a task on a worker
   */
  private runTaskOnWorker(worker: ActiveWorker, task: WorkerTaskExtended): Promise<WorkerResult> {
    return new Promise((resolve) => {
      if (!worker.ready) {
        resolve({
          taskId: task.id,
          success: false,
          error: `Worker ${worker.id} is not ready`,
        });
        return;
      }

      worker.isIdle = false;
      worker.currentTask = task;
      worker.lastUsed = Date.now();

      let stdoutData = '';
      let stderrData = '';
      let resolved = false;

      // Extract onOutput callback if provided
      const onOutput = task.onOutput;
      const proc = worker.process;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (worker.currentTask?.id === task.id) {
          worker.currentTask = null;
          worker.isIdle = true;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        proc.removeListener('message', onMessage);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onProcError);
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolved = true;
      };

      // Set up abort listener
      const abortHandler = () => {
        if (!resolved && worker.currentTask?.id === task.id) {
          cleanup();
          proc.kill('SIGTERM');
          resolve({
            taskId: task.id,
            success: false,
            error: 'Task aborted',
          });
        }
      };

      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      const onMessage = (msg: { type: string; [key: string]: unknown }) => {
        if (msg.type === 'progress' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) return;

          const registry = getBashTaskRegistry();
          registry.updateProgress(task.id, {
            bytes: msg.bytes as number,
            pid: msg.pid as number | null,
            elapsed: msg.elapsed as number,
            timestamp: Date.now(),
          });
        } else if (msg.type === 'backgrounding' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) return;

          // Clear the global timeout — worker will manage its own lifecycle
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }

          const registry = getBashTaskRegistry();
          registry.register({
            id: task.id,
            pid: msg.pid as number,
            outputFile: msg.outputFile as string,
            command: (msg.command as string) || (task.input.command as string) || 'unknown',
            status: 'running',
            startTime: msg.startTime as number || Date.now(),
          });

          // Mark worker as backgrounded — do NOT release it
          worker.isIdle = false;
          worker.currentTask = task;

          resolve({
            taskId: task.id,
            success: true,
            result: `Command moved to background (PID: ${msg.pid}). Use task_output to check progress.`,
            backgrounded: true,
            outputFile: msg.outputFile as string,
            pid: msg.pid as number,
          });
        } else if (msg.type === 'backgrounded' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) return;

          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }

          const registry = getBashTaskRegistry();
          registry.register({
            id: task.id,
            pid: msg.pid as number,
            outputFile: msg.outputFile as string,
            command: (msg.command as string) || (task.input.command as string) || 'unknown',
            status: 'running',
            startTime: msg.startTime as number || Date.now(),
          });

          worker.isIdle = false;
          worker.currentTask = task;

          resolve({
            taskId: task.id,
            success: true,
            result: `Background process started (PID: ${msg.pid})`,
            backgrounded: true,
            outputFile: msg.outputFile as string,
            pid: msg.pid as number,
          });
        } else if (msg.type === 'bg_complete') {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) return;

          const registry = getBashTaskRegistry();
          registry.markCompleted(task.id, (msg.exitCode as number) ?? -1, (msg.error as string | undefined));

          // Release the worker back to pool
          cleanup();
        } else if (msg.type === 'output' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) {
            return;
          }
          const stream = msg.stream as 'stdout' | 'stderr';
          const data = msg.data as string;
          if (stream === 'stdout') {
            stdoutData += data;
          } else {
            stderrData += data;
          }
          // Call onOutput callback if provided
          if (onOutput) {
            onOutput(stream, data);
          }
        } else if (msg.type === 'complete' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) {
            return;
          }
          cleanup();
          resolve({
            taskId: task.id,
            success: msg.success as boolean,
            result: (msg.result ?? stdoutData) || stderrData,
            error: msg.error as string | undefined,
            exitCode: msg.exitCode as number | undefined,
            outputFile: msg.outputFile as string | undefined,
          });
        } else if (msg.type === 'error' && !resolved) {
          const msgTaskId = msg.taskId as string | undefined;
          if (msgTaskId && msgTaskId !== task.id) {
            return;
          }
          cleanup();
          resolve({
            taskId: task.id,
            success: false,
            error: (msg.error as string) || 'Worker returned unknown error',
          });
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) return;
        if (worker.currentTask?.id !== task.id) return;
        const stderrPreview = stderrData.trim().slice(0, 800);
        console.error('[WorkerPool] Worker exited during task', {
          taskId: task.id,
          toolName: task.toolName,
          code,
          signal,
          stderrPreview,
        });
        cleanup();
        resolve({
          taskId: task.id,
          success: false,
          error: `Worker exited unexpectedly (code=${code}, signal=${signal})${stderrPreview ? `: ${stderrPreview}` : ''}`,
        });
      };

      const onProcError = (err: Error) => {
        if (resolved) return;
        if (worker.currentTask?.id !== task.id) return;
        console.error('[WorkerPool] Worker process error during task', {
          taskId: task.id,
          toolName: task.toolName,
          error: err.message,
        });
        cleanup();
        resolve({
          taskId: task.id,
          success: false,
          error: `Worker process error: ${err.message}`,
        });
      };

      proc.on('message', onMessage);
      proc.once('exit', onExit);
      proc.once('error', onProcError);

      // Send task to worker
      if (!proc.send) {
        cleanup();
        resolve({
          taskId: task.id,
          success: false,
          error: 'Worker IPC channel is not available',
        });
        return;
      }

      console.log('[WorkerPool] Sending task to worker', {
        workerId: worker.id,
        taskId: task.id,
        toolName: task.toolName,
        inputKeys: Object.keys(task.input ?? {}),
      });
      try {
        proc.send(
          {
            type: 'execute',
            taskId: task.id,
            toolName: task.toolName,
            input: task.input,
            workingDirectory: task.workingDirectory,
          },
          (sendError) => {
            if (!sendError || resolved) {
              return;
            }
            cleanup();
            resolve({
              taskId: task.id,
              success: false,
              error: `Failed to send task to worker: ${sendError.message}`,
            });
          }
        );
      } catch (sendError) {
        cleanup();
        resolve({
          taskId: task.id,
          success: false,
          error: `Failed to send task to worker: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
        });
        return;
      }

      // Set timeout - use task-level timeout if provided, otherwise global default
      const effectiveTimeout = task.timeoutMs
        ? Math.min(task.timeoutMs, this.workerTimeoutMs * 4)
        : this.workerTimeoutMs;
      timeoutHandle = setTimeout(() => {
        if (!resolved && worker.currentTask?.id === task.id) {
          cleanup();
          proc.kill('SIGTERM');
          resolve({
            taskId: task.id,
            success: false,
            error: `Task timed out after ${effectiveTimeout}ms`,
          });
        }
      }, effectiveTimeout);
    });
  }

  /**
   * Reliably kill a worker process and its subtree.
   * On Windows uses taskkill /F /T; on Unix SIGKILL.
   */
  private async killWorker(worker: ActiveWorker): Promise<void> {
    const pid = worker.process.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
      try {
        await execAsync(`taskkill /F /T /PID ${pid}`, { windowsHide: true });
      } catch {
        // Process may already be gone
      }
    } else {
      try {
        worker.process.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Start periodic cleanup of stale workers
   */
  startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();

      for (const [id, worker] of this.workers.entries()) {
        // Remove workers that have been idle for too long
        if (worker.isIdle && now - worker.lastUsed > this.workerTimeoutMs) {
          void this.killWorker(worker);
          this.workers.delete(id);
          console.log(`[WorkerPool] Cleaned up stale worker: ${id}`);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Stop cleanup and terminate all workers
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [id, worker] of this.workers.entries()) {
      void this.killWorker(worker);
      this.workers.delete(id);
    }

    console.log(`[WorkerPool] Shutdown complete. Active workers: ${this.workers.size}`);
  }

  /**
   * Get pool status
   */
  getStatus(): {
    activeWorkers: number;
    idleWorkers: number;
    queuedTasks: number;
  } {
    let idle = 0;
    let queued = 0;

    for (const worker of this.workers.values()) {
      if (worker.isIdle && !worker.currentTask) {
        idle++;
      }
      queued += worker.taskQueue.length;
    }

    return {
      activeWorkers: this.workers.size - idle,
      idleWorkers: idle,
      queuedTasks: queued,
    };
  }
}

// Global worker pool instance
let globalWorkerPool: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool {
  if (!globalWorkerPool) {
    globalWorkerPool = new WorkerPool();
    globalWorkerPool.startCleanup();
  }
  return globalWorkerPool;
}

export function shutdownWorkerPool(): void {
  if (globalWorkerPool) {
    globalWorkerPool.shutdown();
    globalWorkerPool = null;
  }
}
