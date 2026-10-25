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

import { openSync, readSync, closeSync, statSync } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { join } from 'path';
import { createProcessScope, type ProcessScope, type ProcessTreeKiller, type ScopedProcess } from '@duya/agent-runtime';
import { BASH_MAX_TIMEOUT_MS } from '@duya/capabilities/ShellCommandTool/constants';
import type {
  ShellCommandCompletion,
  ShellCommandHandle,
  ShellCommandRuntimePorts,
  StartShellCommand,
} from '@duya/capabilities/ShellCommandTool/ports';
import type { HostLocalMailboxApiV1 } from '@duya/agent-protocol/mailbox';
import { killProcessTree } from './process-tree-kill.js';
import { getManagedShellOutputDirectory } from './paths.js';
import { getBashTaskRegistry, type BashTaskRegistry } from './task-registry.js';
import {
  sendHostShellNotification,
  type ManagedShellNotificationLogger,
  type ShellTaskNotification,
} from './notifications.js';

/** How much of the output file is pulled back for a foreground result or a
 *  completion notification. The tool layer truncates further (30k chars). */
export const MANAGED_BASH_RESULT_READ_BYTES = 200_000;
/** Inline budget for the output tail embedded in a completion notification —
 *  kept under `DEFAULT_MAX_RESULT_CHARS` so the notification inlines it
 *  instead of degrading to a `get_task_output` pointer. */
export const MANAGED_BASH_NOTIFICATION_TAIL_CHARS = 3_000;

export type ManagedBashStatus = ShellCommandCompletion['status'];
export type ManagedBashCompletion = ShellCommandCompletion;
export type ManagedBashHandle = ShellCommandHandle & { readonly startTime: number };

export interface StartManagedBashParams extends StartShellCommand {
  /**
   * Plan 587 M5.5 -- injection seam. The call owns the child's lifetime, so the
   * scope does too; a test (and a caller that batches several commands under one
   * shutdown) can hand in its own instead of letting each call build one.
   */
  scope?: ProcessScope;
}

export interface ManagedShellDependencies {
  readonly dataRoot?: string;
  readonly outputDirectory?: () => string;
  readonly registry?: ManagedShellTaskRegistryPort;
  readonly mailbox?: Pick<HostLocalMailboxApiV1, 'enqueue'>;
  readonly logger?: ManagedShellNotificationLogger;
  readonly killTree?: ProcessTreeKiller;
  readonly notifyCompletion?: (input: ShellTaskNotification) => void;
}

export type ManagedShellTaskRegistryPort = Pick<
  BashTaskRegistry,
  'register' | 'markKilled' | 'markCompleted' | 'markAutoPromoted'
>;

/**
 * Spawn a command, register it as a background bash task, and return a handle
 * whose `settled` promise reports the terminal state.
 *
 * Throws only when the output file cannot be created; every other failure
 * (missing shell, non-zero exit, watchdog kill) is reported through
 * `settled`.
 */
export async function startManagedShell(
  params: StartManagedBashParams,
  dependencies: ManagedShellDependencies = {},
): Promise<ManagedBashHandle> {
  const { taskId, command, shellPath, shellArgs, cwd, env, sessionId, abortSignal } = params;
  const outputDirectory = dependencies.outputDirectory
    ?? (() => getManagedShellOutputDirectory(dependencies.dataRoot));
  const outputFile = join(outputDirectory(), `duya-bash-${taskId}.log`);
  const startTime = Date.now();
  const registry = dependencies.registry ?? getBashTaskRegistry(
    dependencies.dataRoot === undefined ? {} : { dataRoot: dependencies.dataRoot },
  );
  const killTree: ProcessTreeKiller = dependencies.killTree ?? (async (pid) => {
    await killProcessTree(pid, dependencies.logger ? { logger: dependencies.logger } : undefined);
  });

  // One owner for the child's whole life: the spawn, the watchdog, the abort
  // listener, the output descriptor, and the kill. `dispose()` on settle is what
  // guarantees none of them outlive the command -- previously each of the four
  // exit paths below had to remember all of them by hand.
  // `killProcessTree` reports which strategy ran; the port only wants the
  // effect, so the result is deliberately dropped here rather than widened into
  // the port's signature.
  const scope: ProcessScope = params.scope ?? createProcessScope({
    killTree,
  });

  let fd: FileHandle;
  try {
    fd = await open(outputFile, 'w', 0o644);
  } catch (error) {
    // Nothing was started, so there is nothing to release -- but the scope we
    // just built still owns a slot and must not be left holding a handle.
    await scope.dispose();
    throw new Error(
      `Failed to create output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  scope.track(() => fd.close().catch(() => { /* already closed */ }));
  let checkoutLeaseId: string;
  try { checkoutLeaseId = reserveCheckoutTask({ taskId, cwd, ...(sessionId ? { sessionId } : {}) }, dependencies.dataRoot); }
  catch (error) { await scope.dispose(); throw error; }
  let proc: ScopedProcess;
  try { proc = scope.spawn(shellPath, shellArgs, {
    cwd,
    env,
    // stdin is closed: managed commands must never block on a TTY read.
    stdio: ['ignore', fd.fd, fd.fd],
    windowsHide: true,
  }); } catch (error) {
    releaseCheckoutTask(checkoutLeaseId, dependencies.dataRoot);
    await scope.dispose();
    throw error;
  }

  const pid = proc.pid ?? -1;
  try { bindCheckoutTaskPid(checkoutLeaseId, pid, dependencies.dataRoot); }
  catch (error) { await proc.kill(); await proc.exited; releaseCheckoutTask(checkoutLeaseId, dependencies.dataRoot); await scope.dispose(); throw error; }

  // The descriptor and the abort listener are released by the scope, so neither
  // has to be unwound on each exit path.

  registry.register({
    workingDirectory: cwd,
    ...(sessionId ? { sessionId } : {}),
    checkoutLeaseId,
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
    if (scope.disposed) return;
    watchdog = scope.setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void proc.kill();
    }, ms).handle;
    watchdog.unref?.();
  };

  const onAbort = (): void => {
    if (settled) return;
    canceled = true;
    void proc.kill();
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  scope.track(() => abortSignal?.removeEventListener('abort', onAbort));

  const settle = (exitCode: number, spawnError?: string): void => {
    if (settled) return;
    settled = true;
    releaseCheckoutTask(checkoutLeaseId, dependencies.dataRoot);
    clearWatchdog();
    void scope.dispose();
    abortSignal?.removeEventListener('abort', onAbort);

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
      const notification: ShellTaskNotification = {
        sessionId,
        taskId,
        command,
        outputFile,
        exitCode,
        status,
        text,
        ...(spawnError ? { spawnError } : {}),
      };
      if (dependencies.mailbox) {
        void sendHostShellNotification(dependencies.mailbox, notification, dependencies.logger);
      }
      dependencies.notifyCompletion?.(notification);
    }

    resolveSettled({ taskId, status, exitCode, text, durationMs, ...(error ? { error } : {}) });
  };

  // The scope latches `exited`, so a Node spawn that emits `error` and then
  // `close` still settles exactly once -- which is what the two listeners below
  // used to have to guarantee by hand. The message is still captured, because a
  // bare exit code would lose the "shell not found" diagnosis.
  let spawnError: string | undefined;
  proc.child.once('error', (err: Error) => {
    spawnError = err.message;
  });
  void proc.exited.then((exitCode) => settle(exitCode ?? -1, spawnError));

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

/** Create the capability runtime port using Host-owned process and mailbox services. */
export function createHostShellCommandRuntimePorts(options: {
  readonly dataRoot?: string;
  readonly mailbox: Pick<HostLocalMailboxApiV1, 'enqueue'>;
  readonly logger?: ManagedShellNotificationLogger;
}): ShellCommandRuntimePorts {
  const outputDirectory = () => getManagedShellOutputDirectory(options.dataRoot);
  const registry = getBashTaskRegistry(
    options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot },
  );
  return {
    start: (params) => startManagedShell(params, {
      outputDirectory,
      registry,
      mailbox: options.mailbox,
      ...(options.logger ? { logger: options.logger } : {}),
      killTree: async (pid) => {
        await killProcessTree(pid, options.logger ? { logger: options.logger } : undefined);
      },
    }),
    outputDirectory,
  };
}

/** Compatibility entry point for callers that previously imported Agent's runner. */
export const startManagedBash = startManagedShell;

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
import { reserveCheckoutTask, bindCheckoutTaskPid, releaseCheckoutTask } from '../workspace/task-leases.js';
