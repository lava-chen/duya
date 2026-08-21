/**
 * Process-tree termination helpers.
 *
 * Node's `child_process.spawn` returns a handle for the direct child only.
 * `process.kill(pid, signal)` (and therefore `subprocess.kill()` from
 * execa/Node) maps to `TerminateProcess` on Windows, which only kills the
 * direct PID — bash's grandchildren (cargo / rustc / link.exe / MSYS2
 * subshells / git fetch helpers / ...) survive as orphans. On Unix, the
 * same call targets the PID but does not reach descendants unless the
 * child was put into its own process group with `setpgid(0, 0)` and we
 * send the signal to the negative PGID.
 *
 * This helper closes that gap with the well-known two-strategy approach:
 *
 * - Windows: `taskkill /F /T /PID <pid>` — `/T` walks the tree, `/F`
 *   forces termination. Mirrors the pattern already used in
 *   `BashTool/BashWorker.ts` and what opencode / craft-agents do.
 * - Unix: `process.kill(-pgid, 'SIGTERM')` then escalate to SIGKILL
 *   after a short grace period. The caller is responsible for spawning
 *   the child with `detached: true` so it becomes a process-group
 *   leader; if not, we fall back to `child.kill('SIGKILL')` on the
 *   direct PID and accept the residual risk.
 *
 * Both paths are best-effort: a process that is already gone (ESRCH /
 * "process not found") is treated as success. The helper never throws
 * to the caller — failures are logged and swallowed so cleanup logic
 * can be wired in a `finally` block without needing extra try/catch.
 */
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

const GRACEFUL_KILL_DELAY_MS = 200;
const TASKKILL_TIMEOUT_MS = 5_000;

export interface KillProcessTreeOptions {
  /** Override the SIGTERM→SIGKILL grace window on Unix. Default 200ms. */
  gracefulKillDelayMs?: number;
  /**
   * If true (default), also accept a child whose `pid` is undefined and
   * resolve without doing anything. Set false to make undefined pids
   * surface as a logged warning, which is useful when the caller is
   * certain the child has been spawned.
   */
  allowMissingPid?: boolean;
}

export interface KillProcessTreeResult {
  /** Whether we issued any kill. False when pid was missing/zero. */
  attempted: boolean;
  /** Which strategy ran: 'taskkill', 'pgid', 'direct'. */
  strategy: 'taskkill' | 'pgid' | 'direct' | 'noop';
  /** Wall-clock duration of the kill attempt in ms. */
  durationMs: number;
}

/**
 * Reliably terminate `pid` and every descendant process.
 *
 * Safe to call multiple times for the same pid — taskkill / pgid / kill
 * all no-op on already-dead processes. Safe to call from a `finally`
 * block — never throws.
 */
export async function killProcessTree(
  pid: number | undefined,
  options: KillProcessTreeOptions = {},
): Promise<KillProcessTreeResult> {
  const start = Date.now();

  if (!pid || pid <= 0) {
    if (!options.allowMissingPid) {
      logger.warn(
        'killProcessTree called without a valid pid; skipping',
        { pid },
        'ProcessTreeKill',
      );
    }
    return { attempted: false, strategy: 'noop', durationMs: 0 };
  }

  if (process.platform === 'win32') {
    return await killProcessTreeWindows(pid, start);
  }

  return await killProcessTreeUnix(pid, options.gracefulKillDelayMs ?? GRACEFUL_KILL_DELAY_MS, start);
}

/**
 * Windows variant: `taskkill /F /T /PID <pid>`.
 *
 * Spawned with `stdio: 'ignore'` and `windowsHide: true` so the helper
 * does not flash a console window or block on a hung cmd.exe. The
 * sub-process is awaited with a hard timeout so a wedged taskkill
 * cannot stall agent shutdown.
 */
async function killProcessTreeWindows(
  pid: number,
  start: number,
): Promise<KillProcessTreeResult> {
  return await new Promise<KillProcessTreeResult>((resolve) => {
    let settled = false;
    const settle = (result: KillProcessTreeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let killer: ReturnType<typeof spawn> | undefined;
    try {
      killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      // spawn() itself failed — extremely rare (e.g. taskkill.exe missing).
      logger.warn(
        'taskkill spawn failed',
        { pid, err: errorMessage(err) },
        'ProcessTreeKill',
      );
      settle({ attempted: true, strategy: 'taskkill', durationMs: Date.now() - start });
      return;
    }

    const watchdog = setTimeout(() => {
      logger.warn(
        'taskkill timed out',
        { pid, timeoutMs: TASKKILL_TIMEOUT_MS },
        'ProcessTreeKill',
      );
      settle({ attempted: true, strategy: 'taskkill', durationMs: Date.now() - start });
    }, TASKKILL_TIMEOUT_MS);

    killer.once('exit', () => {
      clearTimeout(watchdog);
      settle({ attempted: true, strategy: 'taskkill', durationMs: Date.now() - start });
    });
    killer.once('error', (err) => {
      clearTimeout(watchdog);
      logger.warn(
        'taskkill error event',
        { pid, err: err.message },
        'ProcessTreeKill',
      );
      settle({ attempted: true, strategy: 'taskkill', durationMs: Date.now() - start });
    });
  });
}

/**
 * Unix variant: SIGTERM the whole process group, escalate to SIGKILL
 * after a grace window. Falls back to direct `process.kill(pid, SIGKILL)`
 * if the child was not spawned with `detached: true`.
 */
async function killProcessTreeUnix(
  pid: number,
  gracefulDelayMs: number,
  start: number,
): Promise<KillProcessTreeResult> {
  // Strategy 1: send SIGTERM to the negative PGID — only works when the
  // child was spawned with `detached: true` and became a process-group
  // leader. ESRCH is the common "process already gone" case and we
  // treat it as success.
  let pgidDelivered = false;
  try {
    pgidDelivered = process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if (!isErrnoCode(err, 'ESRCH')) {
      logger.debug(
        'pgid SIGTERM failed, will fall back',
        { pid, err: errorMessage(err) },
        'ProcessTreeKill',
      );
    }
    pgidDelivered = false;
  }

  if (pgidDelivered) {
    // Wait for graceful exit, then escalate.
    await sleep(gracefulDelayMs);

    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      if (!isErrnoCode(err, 'ESRCH')) {
        logger.warn(
          'pgid SIGKILL failed',
          { pid, err: errorMessage(err) },
          'ProcessTreeKill',
        );
      }
    }

    return { attempted: true, strategy: 'pgid', durationMs: Date.now() - start };
  }

  // Strategy 2: child was not a process-group leader. Best we can do is
  // direct SIGKILL on the immediate child and accept that grandchildren
  // created after spawn but before kill may survive.
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (!isErrnoCode(err, 'ESRCH')) {
      logger.warn(
        'direct SIGKILL failed',
        { pid, err: errorMessage(err) },
        'ProcessTreeKill',
      );
    }
  }

  return { attempted: true, strategy: 'direct', durationMs: Date.now() - start };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}