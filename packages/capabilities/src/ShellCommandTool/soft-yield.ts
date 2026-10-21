/**
 * Soft-yield race — foreground commands that outlive a short wait window are
 * handed off to their already-running background task instead of blocking the
 * conversation until the hard timeout.
 *
 * Mirrors mcode/minimax-code's `raceCompletionWithSoftYield`
 * (`packages/local-runtime/src/background-task/bash-runner-lifecycle.ts`): the
 * command is ALWAYS started as a managed task, so yielding is a pure "stop
 * waiting" decision — the child process is never restarted or killed here.
 *
 * Contract:
 *   - `completion` resolves first  → return its value (still foreground)
 *   - the window elapses first     → return `undefined` (caller promotes)
 *
 * The timer is `unref`ed so a pending yield never keeps the agent process
 * alive on its own, and cleared in `finally` so a fast completion leaves no
 * pending handle behind.
 */

/**
 * Race `completion` against a soft-yield window.
 *
 * A non-finite or non-positive `softYieldMs` disables yielding entirely (the
 * completion is awaited as before) — used by tests and by callers that want
 * the old strictly-foreground behavior.
 */
export async function raceCompletionWithSoftYield<T>(
  completion: Promise<T>,
  softYieldMs: number,
): Promise<T | undefined> {
  if (!Number.isFinite(softYieldMs) || softYieldMs <= 0) {
    return completion;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), softYieldMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
