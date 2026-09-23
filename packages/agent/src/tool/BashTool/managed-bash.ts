/**
 * Managed bash command runner — the single spawn path shared by foreground,
 * auto-promoted, and explicit `run_in_background` shell commands.
 *
 * Why one path: a command is *always* started as a managed background task, and
 * the foreground tool call only decides how long to wait for it (see
 * `raceCompletionWithSoftYield`). That makes soft-yield promotion a pure
 * bookkeeping change — the live child process is never restarted, re-spawned, or
 * killed when the model stops waiting, so no output is lost at the hand-off.
 *
 * Mirrors minimax-code / mcode `packages/local-runtime/src/background-task/bash-runner.ts`:
 *   startAdmittedBackgroundLocalBash() → raceCompletionWithSoftYield() →
 *   auto_promoted (task keeps running, completion delivered asynchronously).
 *
 * Lifetime policy (see constants.ts):
 *   - explicit background (`run_in_background: true`) → no watchdog, unbounded
 *   - foreground call                                → `timeout` watchdog
 *   - auto-promoted call                             → released from the
 *     foreground ceiling, bounded by BASH_MAX_TIMEOUT_MS instead, because the
 *     model stopped waiting and re-running a multi-minute build/test would be
 *     strictly worse than letting it finish.
 */

import { spawn } from 'child_process';
import { openSync, readSync, closeSync, statSync } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { join } from 'path';
import { getBashOutputDir } from '../../utils/duyaRoot.js';
import { killProcessTree } from '../../utils/processTreeKill.js';
import { getBashTaskRegistry } from '../../session/bash-task-registry.js';
import { buildTaskNotificationXml } from '../../lifecycle/buildTaskNotification.js';
import { sendBackgroundNotification } from '../../lifecycle/mailboxBackgroundNotification.js';
import { BASH_MAX_TIMEOUT_MS } from './constants.js';

/** How much of the output file is pulled back for a foreground result or a
 *  completion notification. The tool layer truncates further (30k chars). */
export const MANAGED_BASH_RESULT_READ_BYTES = 200_000;
/** Inline budget for the output tail embedded in a completion notification —
 *  kept under `DEFAULT_MAX_RESULT_CHARS` so the notification inlines it
 *  instead of degrading to a `get_task_output` pointer. */
export const MANAGED_BASH_NOTIFICATION_TAIL_CHARS = 3_000;

export type ManagedBashStatus = 'completed' | 'failed' | 'timeout' | 'canceled';

export interface ManagedBashCompletion {
  taskId: string;
  status: ManagedBashStatus;
  exitCode: number;
  /** Output tail read from the task's output file (already bounded). */
  text: string;
  durationMs: number;
  /** Spawn error or watchdog/cancel explanation, when applicable. */
  error?: string;
}

export interface ManagedBashHandle {
  taskId: string;
  pid: number;
  outputFile: string;
  startTime: number;
  /** Resolves exactly once, when the command reaches a terminal state. Never
   *  rejects — failures are reported through `ManagedBashCompletion.status`. */
  settled: Promise<ManagedBashCompletion>;
  /**
   * Release the command from the foreground watchdog and bound it by the
   * background ceiling instead. Called once at soft yield; the process is left
   * untouched so its output file and PID stay valid.
   */
  promoteToBackground(): void;
}

export interface StartManagedBashParams {
  /** Task id — the originating tool_use id, so the model can correlate the
   *  notification with the call that produced it. */
  taskId: string;
  /** Command as written by the model (registry + notification display). */
  command: string;
  shellPath: string;
  shellArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Watchdog lifetime in ms while the call is still foreground. `null` disables
   * the watchdog entirely (explicit background tasks are unbounded by design).
   */
  foregroundTimeoutMs: number | null;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * Spawn a command, register it as a background bash task, and return a handle
 * whose `settled` promise reports the terminal state.
 *
 * Throws only when the output file cannot be created; every other failure
 * (missing shell, non-zero exit, watchdog kill) is reported through
 * `settled`.
 */
export async function startManagedBash(params: StartManagedBashParams): Promise<ManagedBashHandle> {
  const { taskId, command, shellPath, shellArgs, cwd, env, sessionId, abortSignal } = params;
  const outputFile = join(getBashOutputDir(), `duya-bash-${taskId}.log`);
  const startTime = Date.now();
  const registry = getBashTaskRegistry();

  let fd: FileHandle;
  try {
    fd = await open(outputFile, 'w', 0o644);
  } catch (error) {
    throw new Error(
      `Failed to create output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const proc = spawn(shellPath, shellArgs, {
    cwd,
    env,
    // stdin is closed: managed commands must never block on a TTY read.
    stdio: ['ignore', fd.fd, fd.fd],
    windowsHide: true,
  });

  const pid = proc.pid ?? -1;

  registry.register({
    id: taskId,
    pid,
    outputFile,
    command: command.slice(0, 200),
    status: 'running',
    startTime,
  });

  let timedOut = false;
  let canceled = false;
  let settled = false;
  let watchdog: NodeJS.Timeout | null = null;
  let resolveSettled!: (completion: ManagedBashCompletion) => void;
  const settledPromise = new Promise<ManagedBashCompletion>((resolve) => {
    resolveSettled = resolve;
  });

  const clearWatchdog = (): void => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const armWatchdog = (ms: number | null): void => {
    clearWatchdog();
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return;
    watchdog = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void killProcessTree(pid);
    }, ms);
    watchdog.unref?.();
  };

  const onAbort = (): void => {
    if (settled) return;
    canceled = true;
    void killProcessTree(pid);
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  const settle = (exitCode: number, spawnError?: string): void => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    abortSignal?.removeEventListener('abort', onAbort);
    void fd.close().catch(() => { /* already closed */ });

    const durationMs = Date.now() - startTime;
    const status: ManagedBashStatus = canceled
      ? 'canceled'
      : timedOut
        ? 'timeout'
        : exitCode === 0 && !spawnError
          ? 'completed'
          : 'failed';

    const error =
      spawnError ??
      (timedOut ? `Timed out after ${params.foregroundTimeoutMs}ms` : undefined) ??
      (canceled ? 'Cancelled' : undefined);

    const text = readOutputTail(outputFile, MANAGED_BASH_RESULT_READ_BYTES);

    if (canceled) {
      registry.markKilled(taskId, 'Cancelled');
    } else {
      registry.markCompleted(taskId, exitCode, error);
    }

    if (sessionId) {
      notifyCompletion({ sessionId, taskId, command, outputFile, exitCode, status, text, spawnError, canceled, timedOut });
    }

    resolveSettled({ taskId, status, exitCode, text, durationMs, ...(error ? { error } : {}) });
  };

  proc.on('close', (exitCode) => settle(exitCode ?? -1));
  proc.on('error', (err) => settle(-1, err.message));

  armWatchdog(params.foregroundTimeoutMs);

  return {
    taskId,
    pid,
    outputFile,
    startTime,
    settled: settledPromise,
    promoteToBackground: (): void => {
      if (settled) return;
      registry.markAutoPromoted(taskId, params.foregroundTimeoutMs);
      armWatchdog(BASH_MAX_TIMEOUT_MS);
    },
  };
}

/**
 * Read the tail of an output file. Returns `''` when the file is missing or
 * unreadable — output capture must never be the reason a command call fails.
 */
export function readOutputTail(outputFile: string, maxBytes: number): string {
  try {
    const stat = statSync(outputFile);
    if (stat.size === 0) return '';
    const readStart = Math.max(0, stat.size - maxBytes);
    const fd = openSync(outputFile, 'r');
    try {
      const length = stat.size - readStart;
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, readStart);
      const text = buffer.subarray(0, bytesRead).toString('utf-8');
      return text.trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function notifyCompletion(input: {
  sessionId: string;
  taskId: string;
  command: string;
  outputFile: string;
  exitCode: number;
  status: ManagedBashStatus;
  text: string;
  spawnError?: string;
  canceled: boolean;
  timedOut: boolean;
}): void {
  const { status, text } = input;
  const head =
    status === 'completed'
      ? `Background command completed with exit code ${input.exitCode}.`
      : status === 'timeout'
        ? `Background command timed out (exit code ${input.exitCode}).`
        : status === 'canceled'
          ? 'Background command was cancelled.'
          : `Background command failed with exit code ${input.exitCode}.`;

  const detail = input.spawnError ? `\n${input.spawnError}` : '';
  const tail = text.length > MANAGED_BASH_NOTIFICATION_TAIL_CHARS
    ? `…${text.slice(-MANAGED_BASH_NOTIFICATION_TAIL_CHARS)}`
    : text;

  const xml = buildTaskNotificationXml({
    taskId: input.taskId,
    status: status === 'completed' ? 'completed' : 'failed',
    agentType: 'bash',
    agentName: input.command.slice(0, 200),
    description: input.command.slice(0, 200),
    outputFilePath: input.outputFile,
    finalMessage: `${head}${detail}${tail ? `\n\n${tail}` : ''}`,
  });

  void sendBackgroundNotification({ sessionId: input.sessionId, xml, taskId: input.taskId });
}
