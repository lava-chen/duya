/**
 * BashWorker.ts - Long-running bash command worker
 *
 * This module runs as a separate process and handles bash commands
 * that need streaming output. It communicates with the parent via IPC.
 *
 * Output is written directly to a temp file (file fd) to avoid IPC
 * backpressure on large output. Only lightweight progress metadata
 * is sent over IPC.
 *
 * Usage: node BashWorker.js
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { open, unlink } from 'fs/promises';
import { statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FileHandle } from 'fs/promises';
import { getShellExecConfig, detectShell, type ShellInfo } from '../../utils/shellDetector.js';

const execAsync = promisify(exec);

interface ExecuteTask {
  type: 'execute';
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory?: string;
}

interface AbortTask {
  type: 'abort';
  taskId: string;
}

type WorkerMessage = ExecuteTask | AbortTask

// Active subprocess
let currentProcess: ChildProcess | null = null;
let currentTaskId: string | null = null;
let isShuttingDown = false;

// Track aborted task IDs so close handler knows to include partial output
const abortedTaskIds = new Set<string>();

// Maximum allowed timeout in milliseconds (1 hour)
const MAX_TIMEOUT = 3600000;

// Output size safety limit (500MB)
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

// Progress reporting interval
const PROGRESS_INTERVAL_MS = 1000;
const BG_PROGRESS_INTERVAL_MS = 5000;

// Track the output file handle for the current task
let outputFd: FileHandle | null = null;
let outputFilePath: string | null = null;

// ============================================================================
// Message handling
// ============================================================================

process.on('message', (msg: WorkerMessage) => {
  if (isShuttingDown) return;

  if (msg.type === 'execute') {
    handleExecute(msg);
  } else if (msg.type === 'abort') {
    handleAbort(msg.taskId);
  }
});

// ============================================================================
// Process lifecycle helpers
// ============================================================================

/**
 * Reliably kill the current subprocess and its entire tree.
 * On Windows we use taskkill /F /T because SIGTERM is unreliable.
 */
async function killCurrentProcess(): Promise<void> {
  const proc = currentProcess;
  if (!proc) return;

  currentProcess = null;
  currentTaskId = null;

  const pid = proc.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      await execAsync(`taskkill /F /T /PID ${pid}`, { windowsHide: true });
    } catch {
      // Process may already be gone
    }
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore
    }
  }
}

/**
 * Clean up the output file handle and temp file.
 */
async function cleanupOutputFile(): Promise<void> {
  if (outputFd) {
    try { await outputFd.close(); } catch { /* already closed */ }
    outputFd = null;
  }
  if (outputFilePath) {
    try { await unlink(outputFilePath); } catch { /* already removed */ }
    outputFilePath = null;
  }
}

/**
 * Read the tail of the output file (up to maxBytes). Returns empty string
 * if file doesn't exist or can't be read.
 */
function readOutputTail(maxBytes: number): string {
  if (!outputFilePath) return '';
  try {
    const stat = statSync(outputFilePath);
    if (stat.size === 0) return '';
    const readStart = Math.max(0, stat.size - maxBytes);
    const buf = readFileSync(outputFilePath, { encoding: 'utf-8' });
    // buf is the whole file; take the tail portion
    if (buf.length > maxBytes) {
      return `(truncated - ${stat.size} bytes total)\n\n` + buf.slice(buf.length - maxBytes);
    }
    return buf;
  } catch {
    return '';
  }
}

// ============================================================================
// Core execution logic
// ============================================================================

function handleExecute(task: ExecuteTask): void {
  const { taskId, input } = task;
  const command = input.command as string;
  let timeout = (input.timeout as number) ?? 1200000; // 20min default

  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    timeout = 1200000;
  }
  timeout = Math.min(timeout, MAX_TIMEOUT);

  if (typeof command !== 'string' || command.trim().length === 0) {
    const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
    const err = `[BashWorker] Invalid execute payload: missing command (keys=${inputKeys.join(',') || 'none'})`;
    console.error(err);
    process.send!({ type: 'error', taskId, error: err });
    return;
  }

  // Kill any existing process
  if (currentProcess) {
    void killCurrentProcess();
  }

  currentTaskId = taskId;
  const isBackground = (input.background as boolean) === true;

  console.log(`[BashWorker] Starting: ${command}${isBackground ? ' [background]' : ''}`);

  const shellConfig = getShellExecConfig();
  const shellInfo = detectShell();
  const shell = shellConfig.shell;
  const shellArg = shellConfig.shellArg;

  console.log(`[BashWorker] Using shell: ${shellInfo.name} (${shell})`);

  // Sanitize environment
  const sanitizedEnv = { ...process.env };
  const sensitiveKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'API_KEY', 'SECRET', 'PASSWORD', 'TOKEN'];
  for (const key of sensitiveKeys) {
    if (sanitizedEnv[key]) {
      delete sanitizedEnv[key];
    }
  }

  // Create output file asynchronously
  const filePath = join(tmpdir(), `duya-bash-${taskId}.log`);
  outputFilePath = filePath;

  open(filePath, 'w', 0o644).then(async (fd) => {
    outputFd = fd;

    const proc = spawn(shell, [shellArg, command], {
      cwd: task.workingDirectory || process.cwd(),
      env: sanitizedEnv,
      stdio: ['pipe', fd.fd, fd.fd],
      windowsHide: true,
    });

    currentProcess = proc;

    const startTime = Date.now();
    let killed = false;        // true when process is being terminated (timeout/abort)
    let backgrounded = false;  // true when command was moved to background
    let progressTimer: NodeJS.Timeout | null = null;

    // ---- Background mode: start immediately, no timeout setup ----
    if (isBackground) {
      proc.unref(); // Let the worker exit without waiting for this process

      // Start bg progress reporting
      progressTimer = setInterval(() => sendProgress(taskId, startTime), BG_PROGRESS_INTERVAL_MS);

      process.send!({
        type: 'backgrounded',
        taskId,
        pid: proc.pid,
        outputFile: filePath,
        command: command.slice(0, 200),
        startTime,
      });

      // ---- close handler for background commands ----
      proc.on('close', (exitCode) => {
        if (progressTimer) clearInterval(progressTimer);
        cleanupOutputFileQuietly();
        currentProcess = null;
        currentTaskId = null;

        process.send!({
          type: 'bg_complete',
          taskId,
          exitCode: exitCode ?? -1,
          elapsed: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        if (progressTimer) clearInterval(progressTimer);
        cleanupOutputFileQuietly();
        currentProcess = null;
        currentTaskId = null;

        process.send!({
          type: 'bg_complete',
          taskId,
          exitCode: -1,
          error: err.message,
        });
      });

      return;
    }

    // =====================================================================
    // Foreground mode (with timeout)
    // =====================================================================

    let bgProgressTimer: NodeJS.Timeout | null = null;

    // Start foreground progress reporting
    progressTimer = setInterval(() => sendProgress(taskId, startTime), PROGRESS_INTERVAL_MS);

    // ---- Size watchdog (runs for both foreground and backgrounded) ----
    let sizeWatchdog: NodeJS.Timeout | null = null;
    const startSizeWatchdog = () => {
      if (sizeWatchdog) return;
      sizeWatchdog = setInterval(() => {
        try {
          const stat = statSync(filePath);
          if (stat.size > MAX_OUTPUT_BYTES && !killed) {
            killed = true;
            console.error(`[BashWorker] Output exceeded ${MAX_OUTPUT_BYTES} bytes, killing process`);
            void killCurrentProcess();

            const partial = readOutputTail(100_000);
            process.send!({
              type: 'complete',
              taskId,
              success: false,
              error: `Output exceeded 500MB disk limit`,
              result: partial ? `(partial output - truncated at 500MB limit)\n\n${partial}` : '(no output captured)',
              outputFile: filePath,
            });

            cleanupAll();
          }
        } catch { /* file removed */ }
      }, BG_PROGRESS_INTERVAL_MS);
    };

    // ---- Background transition ----
    const transitionToBackground = () => {
      if (backgrounded || killed) return;
      backgrounded = true;

      // Stop foreground progress, switch to background interval
      if (progressTimer) clearInterval(progressTimer);
      if (bgProgressTimer) clearInterval(bgProgressTimer);
      bgProgressTimer = setInterval(() => sendProgress(taskId, startTime), BG_PROGRESS_INTERVAL_MS);

      // Start size protection
      startSizeWatchdog();

      console.log(`[BashWorker] Transitioning to background: ${taskId}`);

      process.send!({
        type: 'backgrounding',
        taskId,
        pid: proc.pid,
        outputFile: filePath,
        command: command.slice(0, 200),
        elapsed: Date.now() - startTime,
      });
    };

    // ---- Timeout handler: transition to background instead of killing ----
    const timeoutHandle = setTimeout(() => {
      if (!killed && !backgrounded) {
        transitionToBackground();
      }
    }, timeout);

    // ---- Process close ----
    proc.on('close', (exitCode) => {
      clearTimeout(timeoutHandle);
      if (progressTimer) clearInterval(progressTimer);
      if (bgProgressTimer) clearInterval(bgProgressTimer);
      if (sizeWatchdog) clearInterval(sizeWatchdog);

      const wasAborted = abortedTaskIds.has(taskId);
      abortedTaskIds.delete(taskId);

      if (backgrounded && !killed) {
        // Background process finished normally
        process.send!({
          type: 'bg_complete',
          taskId,
          exitCode: exitCode ?? -1,
          outputFile: filePath,
          elapsed: Date.now() - startTime,
        });
      } else if (!killed) {
        // Normal foreground completion
        killed = true;
        const output = readOutputTail(1_000_000);

        let errorMessage = exitCode !== 0 ? `Exit code: ${exitCode}` : undefined;

        // Helpful error for Unix commands on Windows
        if (exitCode !== 0) {
          const shellInfoLocal = detectShell();
          const isCommandNotFound = output.includes('is not recognized') ||
            output.includes('not found') ||
            output.includes('not internal or external command');

          if (isCommandNotFound) {
            const looksUnixSpecific =
              /\b(cat|head|tail|ls|grep|sed|awk|curl|wget|touch|chmod|chown|rm|cp|mv)\b|\/dev\/null|~\//.test(command);
            if (looksUnixSpecific && !shellInfoLocal.supportsUnixCommands) {
              errorMessage = `${errorMessage}. The current shell (${shellInfoLocal.name}) does not support Unix commands. ` +
                `Available alternatives: ` +
                `Use 'type' or 'Get-Content' instead of 'cat', 'Get-ChildItem' instead of 'ls', ` +
                `'$null' instead of '/dev/null'. Consider installing Git Bash for full Unix compatibility.`;
            }
          }
        }

        process.send!({
          type: 'complete',
          taskId,
          success: exitCode === 0,
          result: output.trim() || '(no output)',
          error: errorMessage,
          exitCode,
          outputFile: filePath,
        });
      } else if (wasAborted) {
        const output = readOutputTail(1_000_000);
        process.send!({
          type: 'complete',
          taskId,
          success: false,
          result: output.trim() || '(no output)',
          error: 'Aborted by user',
        });
      } else {
        // Killed by size watchdog
        const partial = readOutputTail(100_000);
        process.send!({
          type: 'complete',
          taskId,
          success: false,
          result: partial ? `(partial output - truncated at 500MB)\n\n${partial}` : '(no output)',
          error: `Output exceeded 500MB disk limit`,
          outputFile: filePath,
        });
      }

      cleanupAll();
    });

    // ---- Process error ----
    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (progressTimer) clearInterval(progressTimer);
      if (bgProgressTimer) clearInterval(bgProgressTimer);
      if (sizeWatchdog) clearInterval(sizeWatchdog);

      if (backgrounded) {
        process.send!({
          type: 'bg_complete',
          taskId,
          exitCode: -1,
          error: err.message,
        });
      } else if (!killed) {
        killed = true;
        const shellInfoLocal = detectShell();
        let errorMsg = err.message;

        if (err.message.includes('ENOENT')) {
          errorMsg = `Failed to spawn shell: ${shellInfoLocal.path} not found. ` +
            `Please ensure ${shellInfoLocal.name} is installed and available.`;
        }

        process.send!({
          type: 'error',
          taskId,
          error: errorMsg,
        });
      }

      cleanupAll();
    });
  }).catch((err) => {
    console.error(`[BashWorker] Failed to create output file:`, err);
    process.send!({
      type: 'error',
      taskId,
      error: `Failed to create output file: ${err.message}`,
    });
    outputFilePath = null;
  });
}

// ============================================================================
// Helpers
// ============================================================================

function sendProgress(taskId: string, startTime: number): void {
  if (!outputFilePath) return;
  try {
    const stat = statSync(outputFilePath);
    process.send!({
      type: 'progress',
      taskId,
      bytes: stat.size,
      pid: currentProcess?.pid,
      elapsed: Date.now() - startTime,
    });
  } catch {
    // File may have been removed
  }
}

function cleanupAll(): void {
  cleanupOutputFileQuietly();
  currentProcess = null;
  currentTaskId = null;
  outputFd = null;
  outputFilePath = null;
}

function cleanupOutputFileQuietly(): void {
  if (outputFd) {
    try { outputFd.close(); } catch { /* ok */ }
    outputFd = null;
  }
  // Don't delete the file on background — it may still be read
}

// ============================================================================
// Abort handling
// ============================================================================

function handleAbort(taskId: string): void {
  if (currentTaskId === taskId && currentProcess) {
    abortedTaskIds.add(taskId);
    void killCurrentProcess();
  }
}

// ============================================================================
// Graceful shutdown
// ============================================================================

async function performShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[BashWorker] Shutting down...');

  if (currentProcess) {
    await killCurrentProcess();
  }

  // Clean up output file
  await cleanupOutputFile();

  process.exit(0);
}

process.on('SIGTERM', () => {
  console.log('[BashWorker] Received SIGTERM');
  void performShutdown();
});

process.on('SIGINT', () => {
  console.log('[BashWorker] Received SIGINT');
  void performShutdown();
});

process.on('disconnect', () => {
  console.log('[BashWorker] Parent disconnected');
  void performShutdown();
});

// ============================================================================
// Startup
// ============================================================================

if (typeof process.send !== 'function') {
  console.error('[BashWorker] FATAL: process.send is not available. Worker must be spawned with IPC channel (stdio: "ipc").');
  process.stderr.write('[BashWorker] FATAL: No IPC channel. Ensure worker is spawned with { stdio: ["pipe", "pipe", "pipe", "ipc"] }\n');
  process.exit(1);
}

process.send({ type: 'ready', pid: process.pid });
console.log(`[BashWorker] Ready, PID: ${process.pid}`);