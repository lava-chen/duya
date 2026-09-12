/**
 * Compaction failure classification and suppression.
 *
 * Aligned with grok's `auto_compact_suppressed` design (grok-build
 * `crates/codegen/xai-grok-shell/src/session/compaction.rs:444-810`):
 *
 * - Five-state suppression machine instead of a single rolling window plus
 *   the old cooldown/loop-strikes/circuit-breaker three-piece set. Each
 *   state has a distinct clear trigger that matches the failure class.
 * - Granular failure reasons (size/schema/auth/credit/other) instead of a
 *   flat deterministic/transient split, so the user-facing message and the
 *   clear trigger can be tuned per class (grok's `SuppressReason`).
 *
 * State machine summary (grok § suppression scope):
 *
 *   NONE           — no suppression; auto-compaction proceeds
 *   TURN           — `other` failure; cleared at the next turn start
 *   STICKY         — `size`/`schema` failure; cleared only on a context-budget
 *                    change (successful compaction / rewind / model switch)
 *   UNTIL_SUCCESS  — `credit` block; cleared when the next LLM call returns 200
 *   AUTH           — `auth` (401); cleared on token / login refresh
 *
 * Manual `/compact` and the `emergency` recovery path bypass every state —
 * they call `compact()` directly, not through `shouldCompact()`.
 */

/** Suppression state for auto-compaction. Mirrors grok's `SUPPRESS_*` consts. */
export const SUPPRESS_NONE = 0
export const SUPPRESS_TURN = 1
export const SUPPRESS_STICKY = 2
export const SUPPRESS_UNTIL_SUCCESS = 3
export const SUPPRESS_AUTH = 4

export type SuppressState =
  | typeof SUPPRESS_NONE
  | typeof SUPPRESS_TURN
  | typeof SUPPRESS_STICKY
  | typeof SUPPRESS_UNTIL_SUCCESS
  | typeof SUPPRESS_AUTH

/** Failure class — drives the user-facing message and the suppression scope. */
export type SuppressReason = 'size' | 'schema' | 'auth' | 'credit' | 'other'

/**
 * Plan 523 P1: the retry ladder throws this when every attempt returned only
 * degenerate/empty summary text (instead of the pre-495 placeholder contract
 * that returned '' — which let bad summaries silently replace real history).
 *
 * It is not a provider/SDK error, so classification must not match against
 * token/credit/auth keywords; it always drives a TURN-scoped suppression.
 */
export class SummaryDegenerateError extends Error {
  readonly attempts: number
  readonly lastChars: number
  constructor(attempts: number, lastChars: number) {
    super(
      `[summary-retry] received only degenerate/empty summaries across ${attempts} attempts ` +
        `(last probe was ${lastChars} chars)`,
    )
    this.name = 'SummaryDegenerateError'
    this.attempts = attempts
    this.lastChars = lastChars
  }
}

const REASON_TO_STATE: Readonly<Record<SuppressReason, SuppressState>> = {
  size: SUPPRESS_STICKY,
  schema: SUPPRESS_STICKY,
  auth: SUPPRESS_AUTH,
  credit: SUPPRESS_UNTIL_SUCCESS,
  other: SUPPRESS_TURN,
}

/**
 * Legacy flat classification used by callers that only need retry-yes/no.
 * Kept for backwards compatibility — `isRetryableCompactFailure` still works
 * with this. New code should consume {@link SuppressReason} via
 * {@link classifySuppressReason}.
 */
export type CompactFailureKind = 'deterministic' | 'transient' | 'cancelled'

/**
 * Classify a compaction error into a retryability bucket.
 */
export function classifyCompactFailure(error: unknown): CompactFailureKind {
  const reason = classifySuppressReason(error)
  if (reason === null) return 'cancelled'
  if (reason === 'size' || reason === 'schema' || reason === 'auth') return 'deterministic'
  return 'transient'
}

/**
 * True when the failure should be retried / counted against the suppress window.
 */
export function isRetryableCompactFailure(kind: CompactFailureKind): boolean {
  return kind === 'transient'
}

/**
 * Classify a compaction error into a grok-style {@link SuppressReason}. The
 * mapping mirrors grok `classify_suppress_reason`:
 *
 * - credit/balance keywords → `credit`
 * - context-length errors     → `size`
 * - 401 / unauthorized         → `auth`
 * - invalid_request_error     → `schema`
 * - everything else           → `other`
 * - abort / cancel             → returns null (caller should skip suppression)
 */
export function classifySuppressReason(error: unknown): SuppressReason | null {
  const message = error instanceof Error ? error.message : String(error)
  if (!message) return 'other'

  // Plan 523 P1: a degenerate summary exhausted the retry ladder. This is a
  // quality failure, not a token/credit/auth/schema problem — drive a
  // TURN-scoped suppression so the next turn (context grew again) retries.
  if (error instanceof SummaryDegenerateError) return 'other'

  if (/abort|cancelled|cancel/i.test(message)) return null

  const m = message.toLowerCase()

  // Credit / spending block (grok: `spending-limit`, `out of credits`,
  // `usage balance exhausted`, `usage limit reached`).
  if (
    m.includes('spending-limit') ||
    m.includes('spending limit') ||
    m.includes('out of credits') ||
    m.includes('usage balance exhausted') ||
    m.includes('usage limit reached')
  ) {
    return 'credit'
  }

  // Context-length / prompt-too-long → STICKY (grok: `Size`).
  if (
    m.includes('context_length_exceeded') ||
    m.includes('prompt_too_long') ||
    m.includes('context window exceeds limit') ||
    m.includes('invalid prompt') ||
    m.includes('invalid_argument')
  ) {
    return 'size'
  }

  // Auth — 401 / unauthorized (grok: `Auth`).
  if (
    /\b401\b/.test(m) ||
    m.includes('unauthorized') ||
    m.includes('authentication')
  ) {
    return 'auth'
  }

  // Invalid request / schema — STICKY (grok: `Schema`).
  if (m.includes('invalid_request_error') || m.includes('bad request')) {
    return 'schema'
  }

  // 4xx (excluding 408/429) are deterministic at this granularity; we
  // already peeled off 401/auth above, so the residual bucket is `other`
  // (TURN-scoped) — matching the old `deterministic → suppress('session')`
  // behavior. Network/5xx/timeout falls here too, but they are transient
  // so a one-turn suppression is enough.
  return 'other'
}

/**
 * Map a {@link SuppressReason} to its {@link SuppressState}. Mirrors grok
 * `SuppressReason::suppress_state` exactly:
 *
 *   size | schema   → STICKY        (cleared on context-budget change)
 *   credit          → UNTIL_SUCCESS (cleared on next LLM 200)
 *   auth            → AUTH          (cleared on token / login refresh)
 *   other           → TURN          (cleared at next turn start)
 */
export function reasonToSuppressState(reason: SuppressReason): SuppressState {
  return REASON_TO_STATE[reason]
}

/**
 * Stable string key for telemetry / log filters. Mirrors grok's
 * `SuppressReason::as_str`.
 */
export function suppressReasonToString(reason: SuppressReason): string {
  return reason
}

/**
 * Stable string key for the state. Used by callers that want a debug-friendly
 * representation without leaking the numeric enum.
 */
export function suppressStateToString(state: SuppressState): string {
  switch (state) {
    case SUPPRESS_NONE:
      return 'none'
    case SUPPRESS_TURN:
      return 'turn'
    case SUPPRESS_STICKY:
      return 'sticky'
    case SUPPRESS_UNTIL_SUCCESS:
      return 'until_success'
    case SUPPRESS_AUTH:
      return 'auth'
  }
}

/**
 * Human-readable user message for a suppression reason. Mirrors the
 * `AutoCompactFailed` notifications grok sends (see `suppress_auto_compaction`
 * in grok `compaction.rs`).
 */
export function suppressReasonMessage(reason: SuppressReason): string {
  switch (reason) {
    case 'credit':
      return 'Out of credits or over your spending limit. Add credits and retry.'
    case 'auth':
      return 'Authentication problem — re-authenticate using /login and retry.'
    case 'size':
      return 'This conversation is too large to compact.'
    case 'schema':
      return 'This conversation can\'t be summarized.'
    case 'other':
      return 'Auto-compaction failed; it will retry on the next turn, or start a new session using /new.'
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Legacy suppression-window API
// ───────────────────────────────────────────────────────────────────────────
//
// The old design used a per-scope rolling window (`CompactSuppression` keyed
// by scope id, suppressed until `now + SUPPRESS_WINDOW_MS`). That is a strict
// subset of the 5-state machine: any state ≠ `NONE` is equivalent to "within
// the suppression window". We keep the legacy API working so existing callers
// (`CompactionManager`) and tests do not need to change shape, but new code
// should call the 5-state methods directly.

/**
 * Suppression window for the legacy per-scope API. Only used by
 * `CompactSuppression.suppress(scope, now)`; the 5-state machine has its own
 * clear triggers (see {@link CompactSuppression.clearOnTurnStart} etc.).
 *
 * @deprecated Use the 5-state machine methods.
 */
export const SUPPRESS_WINDOW_MS = 10_000

/**
 * Five-state suppression machine with backwards-compatible per-scope API.
 *
 * The internal numeric `state` plays the role of grok's `AtomicU8`. We don't
 * need atomic semantics (this is a single-threaded JS agent loop), but we
 * preserve the `compare_exchange(NONE → X)` upgrade rule so a second failure
 * during suppression does not silently downgrade the scope.
 *
 * Two parallel APIs:
 *
 * 1. **Five-state** (preferred for new code):
 *    {@link trySuppress}, {@link isActive}, {@link clearOnTurnStart},
 *    {@link clearOnBudgetChange}, {@link clearOnSuccess},
 *    {@link clearOnAuthRefresh}, {@link reset}.
 *
 * 2. **Legacy per-scope** (back-compat with the pre-grok-aligned code):
 *    {@link suppress} / {@link isSuppressed} / {@link clear}. These map onto
 *    the 5-state machine as `other` reason + the "any active state" view.
 */
export class CompactSuppression {
  /**
   * Current state. Public-read via {@link getState} for callers that want to
   * surface it in telemetry / UI (mirrors grok `record_compaction_variant`).
   */
  private state: SuppressState = SUPPRESS_NONE

  /** Last applied reason, for diagnostics. */
  private lastReason: SuppressReason | null = null

  // ─── Five-state machine API ────────────────────────────────────────

  /** Read the current state. */
  getState(): SuppressState {
    return this.state
  }

  /** Read the last reason that drove the current (or previous) state. */
  getLastReason(): SuppressReason | null {
    return this.lastReason
  }

  /** True when auto-compaction is currently gated (any state ≠ NONE). */
  isActive(): boolean {
    return this.state !== SUPPRESS_NONE
  }

  /**
   * Try to apply a suppression. Mirrors grok's `compare_exchange(SUPPRESS_NONE
   * → new_state)` — only succeeds when the current state is `NONE`, so a
   * second failure during an active suppression does not silently downgrade
   * the scope (STICKY stays STICKY, etc.).
   *
   * Returns true when the state changed, false when the transition was
   * rejected (already suppressed).
   */
  trySuppress(reason: SuppressReason): boolean {
    if (this.state !== SUPPRESS_NONE) return false
    this.state = reasonToSuppressState(reason)
    this.lastReason = reason
    return true
  }

  /**
   * Turn-boundary clear. Mirrors the clear-on-turn-start transition in
   * grok `compaction.rs` (`turn.rs:2108` checks happen at the start of each
   * turn, after the suppression gate): only `TURN` clears, anything else
   * (STICKY/UNTIL_SUCCESS/AUTH) survives because their clear trigger has
   * not happened yet.
   *
   * Returns true when the state actually changed.
   */
  clearOnTurnStart(): boolean {
    if (this.state !== SUPPRESS_TURN) return false
    this.state = SUPPRESS_NONE
    this.lastReason = null
    return true
  }

  /**
   * Context-budget-change clear. Called after a successful compaction
   * (`tokensAfter < tokensBefore`), after a rewind, or after a model
   * switch. Mirrors grok's STICKY clear semantics: only `STICKY` clears.
   *
   * Other states are intentionally preserved (e.g. AUTH must wait for a
   * real login, not for a turn).
   *
   * Returns true when the state actually changed.
   */
  clearOnBudgetChange(): boolean {
    if (this.state !== SUPPRESS_STICKY) return false
    this.state = SUPPRESS_NONE
    this.lastReason = null
    return true
  }

  /**
   * Success-path clear. Called when the agent sees a healthy LLM
   * response (200, valid usage, not aborted). Clears everything except
   * AUTH — auth gating has its own dedicated trigger
   * ({@link clearOnAuthRefresh}).
   *
   * Mirrors grok's "credits aren't client-observable, but over-window
   * deadlock means we can't wait for 200 — so auth clears on login,
   * everything else on success".
   *
   * Returns true when the state actually changed.
   */
  clearOnSuccess(): boolean {
    if (this.state === SUPPRESS_NONE || this.state === SUPPRESS_AUTH) return false
    this.state = SUPPRESS_NONE
    this.lastReason = null
    return true
  }

  /**
   * Auth-clear. Called when a token refresh or `/login` succeeds. Only
   * AUTH clears; other states are unrelated to auth and survive.
   *
   * Returns true when the state actually changed.
   */
  clearOnAuthRefresh(): boolean {
    if (this.state !== SUPPRESS_AUTH) return false
    this.state = SUPPRESS_NONE
    this.lastReason = null
    return true
  }

  /** Reset to NONE (used by `clearCache` / new session). */
  reset(): void {
    this.state = SUPPRESS_NONE
    this.lastReason = null
  }

  // ─── Legacy per-scope API (back-compat) ────────────────────────────
  //
  // The old `suppress(scope, now) / isSuppressed(scope, now) / clear(scope)`
  // interface was keyed by scope id. The 5-state machine is single-scope
  // (`session`), so we map the legacy calls onto it: any `suppress(scope)`
  // call applies an `other` reason (TURN-scoped), and any
  // `isSuppressed(scope)` returns true whenever the machine is active.
  // The 2nd-arg `now` is ignored (the 5-state has its own clear triggers),
  // but kept in the signature so existing callers compile.

  /** Legacy: mark a scope suppressed (applies `other` reason). */
  suppress(scope: string, _now = Date.now()): void {
    void scope
    this.trySuppress('other')
  }

  /** Legacy: true while the scope is within its suppression window. */
  isSuppressed(scope: string, _now = Date.now()): boolean {
    void scope
    return this.isActive()
  }

  /** Legacy: clear suppression for a scope. */
  clear(scope: string): void {
    void scope
    this.reset()
  }
}