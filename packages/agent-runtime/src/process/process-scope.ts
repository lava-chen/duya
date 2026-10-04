/**
 * Plan 587 M5.5 -- `ProcessScope`: the one owner of a spawned child's lifetime.
 *
 * ## The debt this replaces
 *
 * Three sites each grew their own version of "start a child, arm a timer, and
 * remember to release both":
 *
 * - `packages/agent/src/tool/BashTool/managed-bash.ts` -- a watchdog timer, an
 *   `AbortSignal` listener, a file descriptor, and a `settled` latch that all
 *   have to be released on every one of the four exit paths.
 * - `packages/agent/src/tool/WorkerPool.ts` -- a task timeout plus a
 *   `setInterval` sweep, with `killWorker` re-implementing the Windows
 *   `taskkill /F /T` dance that `processTreeKill` already owns and tests.
 * - `packages/agent/src/tool/BashTool/BashWorker.ts` -- a third copy of the same
 *   `taskkill` / `SIGKILL` escalation.
 *
 * Each copy is individually correct-ish and collectively a leak class: a missed
 * `clearTimeout` keeps the event loop alive, a missed `removeEventListener`
 * retains the closure, and a kill that only reaches the direct PID leaves
 * grandchildren orphaned on Windows.
 *
 * ## What this deliberately does NOT do
 *
 * It does not own the platform kill *strategy*. Both sides of the boundary
 * already have a tested one -- the agent has `utils/processTreeKill.ts`, the host
 * has `main/lib/process-cleanup.ts` -- and collapsing them into one function
 * here would either move a tested, eval-pinned module for no architectural gain
 * or force a new cross-boundary import. So the killer is an **injected port**
 * and the scope owns only the bookkeeping: what was started, and that it is
 * released exactly once.
 *
 * That is the whole claim. A narrow port with real consumers beats a complete
 * abstraction with none, and an injected strategy is the difference between the
 * two.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

// ── Ports ────────────────────────────────────────────────────────────────────

/** Terminates a process tree. Injected: the strategy is the caller's platform. */
export type ProcessTreeKiller = (pid: number | undefined) => Promise<void> | void;

/**
 * The single-signature view of `child_process.spawn`.
 *
 * Deliberately NOT `typeof spawn`: that is a 10-overload union, and calling it
 * through the union reduces the result to `never`, which loses `pid` and `once`
 * at compile time. (vitest does not typecheck, so this class of error reaches a
 * green suite and is only caught by `typecheck:all` -- which is exactly why that
 * gate is run explicitly rather than inferred from a passing test run.)
 */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Releases one resource. May be async; `dispose()` awaits in reverse order. */
export type ScopedCloser = () => void | Promise<void>;

/** What `spawn` hands back: the child, plus a single-settle exit promise. */
export interface ScopedProcess {
  /** The underlying child. The caller still owns its stdio. */
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  /**
   * Resolves exactly once with the exit code (`null` when killed by a signal).
   *
   * Node emits `error` and then `close` for a failed spawn, so a naive
   * `Promise.race` settles once but a naive pair of `.then`s settles twice and
   * runs cleanup twice. This latches.
   */
  readonly exited: Promise<number | null>;
  /**
   * Terminate this child's tree NOW, through the scope's injected strategy.
   *
   * This is how a caller aborts or times out a command without reaching for
   * `child_process` itself: the strategy lives in exactly one place, so a test
   * substitutes a fake and a platform difference is fixed once. Never throws --
   * a process that is already gone is the common case, not a failure.
   */
  kill(): Promise<void>;
}

/** A timer the scope will release. Mirrors the Node handle it wraps. */
export interface ScopedTimer {
  /** Cancel the timer and drop it from the scope. Safe to call repeatedly. */
  cancel(): void;
  /** The Node handle, for the rare caller that needs `unref`/`refresh`. */
  readonly handle: NodeJS.Timeout;
}

export interface ProcessScope {
  /** True once `dispose()` has run. Guards every mutator below. */
  readonly disposed: boolean;
  /** How many children this scope is currently holding. */
  readonly childCount: number;
  /** How many timers this scope is currently holding. */
  readonly timerCount: number;

  spawn(command: string, args: readonly string[], options?: SpawnOptions): ScopedProcess;
  setTimeout(callback: () => void, delayMs: number): ScopedTimer;
  setInterval(callback: () => void, delayMs: number): ScopedTimer;
  /**
   * Subscribe to a child's `exit`. The listener is removed on `dispose()`, so a
   * scope cannot leave a closure retained by a long-dead child.
   */
  onExit(process: ScopedProcess, listener: (code: number | null) => void): void;
  /** Register arbitrary cleanup -- a file descriptor, an AbortSignal listener. */
  track(closer: ScopedCloser): void;
  /** Release everything, children last. Idempotent. Never throws. */
  dispose(): Promise<void>;
}

// ── Implementation ───────────────────────────────────────────────────────────

export interface ProcessScopeOptions {
  /**
   * The platform kill strategy. Required rather than defaulted: a default would
   * have to pick a platform, and the two consumers of this port already hold
   * different, differently-tested answers to that question.
   */
  killTree: ProcessTreeKiller;
  /** Injection seam for the spawn call. Defaults to `node:child_process.spawn`. */
  spawnFn?: ProcessSpawner;
  /** How long `dispose()` waits for the killers before giving up. Default 5s. */
  killTimeoutMs?: number;
}

const DEFAULT_KILL_TIMEOUT_MS = 5_000;

export function createProcessScope(options: ProcessScopeOptions): ProcessScope {
  const {
    killTree,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    spawnFn = (command, args, options) => nodeSpawn(command, args, options),
  } = options;

  const children: ScopedProcess[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const closers: ScopedCloser[] = [];
  let disposed = false;

  const detachTimer = (handle: NodeJS.Timeout): void => {
    timers.delete(handle);
  };

  const arm = (handle: NodeJS.Timeout): ScopedTimer => {
    timers.add(handle);
    return {
      handle,
      cancel: (): void => {
        clearTimeout(handle);
        clearInterval(handle);
        detachTimer(handle);
      },
    };
  };

  const scope: ProcessScope = {
    get disposed(): boolean {
      return disposed;
    },
    get childCount(): number {
      return children.length;
    },
    get timerCount(): number {
      return timers.size;
    },

    spawn(command, args, spawnOptions): ScopedProcess {
      if (disposed) {
        // Refusing loudly is better than spawning something nobody will clean up.
        throw new Error('ProcessScope.spawn after dispose');
      }
      const child = spawnFn(command, args, spawnOptions ?? {});

      let settleExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => {
        settleExit = resolve;
      });
      const handle: ScopedProcess = {
        child,
        pid: child.pid,
        exited,
        kill: async (): Promise<void> => {
          try {
            await withTimeout(Promise.resolve(killTree(child.pid)), killTimeoutMs);
          } catch {
            // Already gone, or a platform refusal. Cleanup must not throw.
          }
        },
      };
      let latched = false;
      const settle = (code: number | null): void => {
        if (latched) return;
        latched = true;
        settleExit(code);
      };

      // `error` fires for a spawn that never started; `close` fires afterwards
      // too. One latch, so downstream cleanup runs exactly once.
      child.once('error', () => {
        settle(null);
        removeChild(handle);
      });
      child.once('close', (code: number | null) => {
        settle(code);
        removeChild(handle);
      });

      children.push(handle);
      return handle;
    },

    setTimeout(callback, delayMs): ScopedTimer {
      if (disposed) throw new Error('ProcessScope.setTimeout after dispose');
      // Detach on fire as well as on cancel, so a one-shot timer stops counting
      // against `timerCount` the moment it has done its work.
      let handle: NodeJS.Timeout;
      handle = setTimeout(() => {
        detachTimer(handle);
        callback();
      }, delayMs);
      return arm(handle);
    },

    setInterval(callback, delayMs): ScopedTimer {
      if (disposed) throw new Error('ProcessScope.setInterval after dispose');
      return arm(setInterval(callback, delayMs));
    },

    onExit(process, listener): void {
      if (disposed) return;
      const bound = (code: number | null): void => listener(code);
      process.child.once('close', bound);
      closers.push(() => {
        process.child.removeListener('close', bound);
      });
    },

    track(closer): void {
      if (disposed) {
        // Already torn down: run the cleanup immediately rather than dropping it.
        void closer();
        return;
      }
      closers.push(closer);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Timers first, so nothing fires while we are killing.
      for (const handle of timers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      timers.clear();

      // Then the caller's own resources (fds, AbortSignal listeners) in reverse
      // registration order, so a later registration that depends on an earlier
      // one is released before it.
      for (let i = closers.length - 1; i >= 0; i -= 1) {
        const closer = closers[i];
        if (!closer) continue;
        try {
          await closer();
        } catch {
          // Cleanup is best-effort: one failing closer must not strand the rest.
        }
      }
      closers.length = 0;

      // Children last, and all of them even if one kill rejects.
      const doomed = children.splice(0, children.length);
      const kills = doomed.map(async (handle) => {
        try {
          await withTimeout(Promise.resolve(killTree(handle.pid)), killTimeoutMs);
        } catch {
          // A process that is already gone is the common case, not a failure.
        }
      });
      await Promise.all(kills);
    },
  };

  const removeChild = (handle: ScopedProcess): void => {
    const index = children.indexOf(handle);
    if (index >= 0) children.splice(index, 1);
  };

  return scope;
}

/** Resolve `promise`, or give up after `ms` so a wedged killer cannot hang a
 *  shutdown. Mirrors the watchdog `processTreeKill` already carries. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let handle: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}
