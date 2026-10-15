/**
 * circuit-breaker.ts — per-(session, event, command) hook circuit breaker.
 *
 * A hook that crashes (spawn failure, module-not-found, timeout, repeated
 * non-zero exits without diagnostic output) is re-dispatched on EVERY turn
 * (UserPromptSubmit fires per user message, loop events per turn). Before
 * the breaker, a broken hook spawned a failing process every turn and —
 * for `asyncRewake` hooks — injected a fresh failure notification into the
 * model context each time (bug report 2026-08-19 #8).
 *
 * The breaker is keyed by session + event + command line so:
 *  - a broken hook in one session never suppresses the same hook elsewhere;
 *  - a hook that recovers (next run succeeds) closes the breaker
 *    immediately (`recordSuccess` resets the state);
 *  - once opened, the hook is skipped until the cooldown expires, then it
 *    is allowed one probe run (half-open) before re-opening.
 *
 * Only infrastructure failures trip the breaker: spawn errors, timeouts,
 * and non-zero exits that produced no usable output. A verifier-style hook
 * that runs and reports problems (non-zero exit WITH diagnostics) is
 * working as intended and never trips it — see the `verifier` flag on
 * `recordFailure`.
 */

interface BreakerState {
  failures: number;
  firstFailureAt: number;
  openedAt: number | null;
}

/** Stable breaker key for one hook instance. */
export function hookBreakerKey(
  sessionId: string,
  event: string,
  commandLine: string,
): string {
  return `${sessionId}:${event}:${commandLine}`;
}

export class HookCircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(
    /** Consecutive failures within `windowMs` that open the breaker. */
    private readonly maxFailures = 3,
    /** Sliding window over which failures accumulate. */
    private readonly windowMs = 10 * 60 * 1000,
    /** How long the breaker stays open before one probe run is allowed. */
    private readonly cooldownMs = 5 * 60 * 1000,
  ) {}

  /**
   * Whether the hook may run now. Returns false while the breaker is open;
   * when the cooldown has expired the breaker goes half-open and one probe
   * run is allowed. The state is kept so a probe failure re-opens the
   * breaker immediately; a probe success closes it via `recordSuccess`.
   */
  check(key: string): boolean {
    const s = this.states.get(key);
    if (!s || s.openedAt === null) return true;
    return Date.now() - s.openedAt >= this.cooldownMs;
  }

  /** A successful run resets the failure count for this hook. */
  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  /**
   * Record an infrastructure failure. When `verifier` is true (the process
   * ran and reported diagnostics) the failure is by design and does not
   * trip the breaker. A probe failure after the cooldown (state still has
   * `openedAt` set) re-opens the breaker immediately.
   */
  recordFailure(key: string, verifier = false): void {
    if (verifier) return;
    const now = Date.now();
    let s = this.states.get(key);
    if (!s) {
      s = { failures: 1, firstFailureAt: now, openedAt: null };
    } else if (s.openedAt !== null) {
      // Half-open probe failed — re-open immediately.
      s.failures = this.maxFailures;
      s.openedAt = now;
      this.states.set(key, s);
      return;
    } else if (now - s.firstFailureAt > this.windowMs) {
      s.failures = 1;
      s.firstFailureAt = now;
    } else {
      s.failures += 1;
    }
    if (s.failures >= this.maxFailures && s.openedAt === null) {
      s.openedAt = now;
    }
    this.states.set(key, s);
  }

  /** Human-readable open state for logs; null when the breaker is closed. */
  describe(key: string): string | null {
    const s = this.states.get(key);
    if (!s || s.openedAt === null) return null;
    const remainMs = Math.max(0, this.cooldownMs - (Date.now() - s.openedAt));
    return `${s.failures}/${this.maxFailures} failures; suppressed for ${Math.ceil(remainMs / 1000)}s`;
  }

  /** Test helper: drop every breaker state. */
  clear(): void {
    this.states.clear();
  }
}

/** Process-wide singleton — one breaker for all sessions/events. */
export const hookCircuitBreaker = new HookCircuitBreaker();
