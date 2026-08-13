/**
 * Compaction failure classification and suppression.
 *
 * Failures are split into deterministic (won't succeed on retry) and transient
 * (may succeed on retry). Only transient failures should be retried / counted
 * against the circuit breaker; deterministic ones are surfaced immediately.
 */

export type CompactFailureKind = 'deterministic' | 'transient' | 'cancelled'

/**
 * Classify a compaction error into a retryability bucket.
 */
export function classifyCompactFailure(error: unknown): CompactFailureKind {
  const message = error instanceof Error ? error.message : String(error)

  // User/agent aborted — never retry.
  if (/abort|cancelled|cancel/i.test(message)) return 'cancelled'

  // HTTP 4xx (except 408 timeouts / 429 rate-limit) are deterministic.
  const status = message.match(/\b(4\d\d|5\d\d)\b/)
  if (status) {
    const code = Number(status[1])
    if (code === 408 || code === 429) return 'transient'
    if (code >= 400 && code < 500) return 'deterministic'
  }

  // Provider-side context window / invalid input — retry won't help.
  if (/context_length_exceeded|prompt_too_long|invalid prompt|invalid_argument/i.test(message)) {
    return 'deterministic'
  }

  // Everything else (network, rate, timeout, 5xx) is transient.
  return 'transient'
}

/**
 * True when the failure should be retried / counted against the suppress window.
 */
export function isRetryableCompactFailure(kind: CompactFailureKind): boolean {
  return kind === 'transient'
}

/**
 * Suppression window for a failed compaction: suppresses auto-compaction for
 * this many milliseconds so a failing provider does not repeatedly trigger it.
 */
export const SUPPRESS_WINDOW_MS = 10_000

/**
 * Tracks per-scope suppression. A scope is e.g. the session id; once a
 * deterministic failure is observed, auto-compaction is suppressed for the
 * window so the loop does not spin.
 */
export class CompactSuppression {
  private suppressedAt = new Map<string, number>()

  /** Mark a scope suppressed. */
  suppress(scope: string, now = Date.now()): void {
    this.suppressedAt.set(scope, now + SUPPRESS_WINDOW_MS)
  }

  /** Clear suppression for a scope. */
  clear(scope: string): void {
    this.suppressedAt.delete(scope)
  }

  /** True while the scope is within its suppression window. */
  isSuppressed(scope: string, now = Date.now()): boolean {
    const until = this.suppressedAt.get(scope)
    return until !== undefined && now < until
  }
}