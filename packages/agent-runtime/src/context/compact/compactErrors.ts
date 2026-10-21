/**
 * Compaction failure classification (plan 552 slim-down).
 *
 * Aligned with grok's `classify_suppress_reason` (grok-build
 * `crates/codegen/xai-grok-shell/src/session/compaction.rs`). This module now
 * only classifies; the suppression state machine itself lives in
 * `CompactionManager`'s `Suppression` class (3 failure scopes: size / auth /
 * other). The former 5-state `CompactSuppression` machine that also lived
 * here had zero production call sites and was removed — plan 523 should
 * extend the live machine instead of reviving it.
 */

/** Failure class — drives the suppression scope and the user-facing message. */
export type SuppressReason = 'size' | 'schema' | 'auth' | 'credit' | 'other'

/**
 * Plan 577 Phase 0: how strongly a stream error claims "the context/prompt
 * itself is too big".
 *
 * - `explicit` — the provider unambiguously says the prompt/context exceeded
 *   the model's window. Trustworthy on its own (the local budget may itself be
 *   misresolved, so a local probe is NOT more authoritative here).
 * - `weak`     — generic "…exceeds limit" wording that non-context errors
 *   (output caps, payload caps, rate limits phrased oddly) also produce. Must
 *   be corroborated by local evidence before an emergency compaction fires.
 * - `null`     — not a context-length claim at all.
 */
export type ContextLengthErrorKind = 'explicit' | 'weak' | null

/**
 * Narrow context-length classifier for the EMERGENCY compaction path
 * (plan 577 Phase 0). Deliberately NOT {@link classifySuppressReason}: that
 * one maps `invalid prompt` / `invalid_argument` onto `size` too, which is
 * far too wide to justify a threshold-free emergency compaction.
 *
 * Before this helper, the emergency gate was the raw substring
 * `errorMessage.includes('exceeds limit')` with no threshold check — any
 * unrelated error carrying that phrase compacted the session at arbitrary
 * context sizes (2026-09-28 investigation).
 */
export function classifyContextLengthError(message: string): ContextLengthErrorKind {
  if (!message) return null
  const m = message.toLowerCase()

  // Provider explicitly says the prompt/context exceeded the model window.
  const explicitMarkers = [
    'context_length_exceeded', // OpenAI error code
    'prompt_too_long', // Anthropic error code
    'context window exceeds limit',
    'exceeds the context window',
    'maximum context length', // OpenAI message prose
    'context length exceeded',
    'prompt is too long', // Anthropic message prose
    'input length exceeds',
    'input tokens exceed',
    'too many input tokens',
  ]
  if (explicitMarkers.some((marker) => m.includes(marker))) return 'explicit'

  // Generic residue — the old gate's whole match surface. Non-context errors
  // (output caps, payload caps, quota wording) can produce these phrases, so
  // callers must double-check against local context evidence.
  if (m.includes('exceeds limit') || m.includes('exceeds the limit')) return 'weak'

  return null
}

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
 * Human-readable user message for a suppression reason. Mirrors the
 * `AutoCompactFailed` notifications grok sends (see `suppress_auto_compaction`
 * in grok `compaction.rs`). Surfaced on the `compaction_error` event.
 */
export function suppressReasonMessage(reason: SuppressReason): string {
  switch (reason) {
    case 'credit':
      return 'Out of credits or over your spending limit. Add credits and retry.'
    case 'auth':
      return 'Authentication problem — re-authenticate and retry.'
    case 'size':
      return 'This conversation is too large to compact.'
    case 'schema':
      return "This conversation can't be summarized."
    case 'other':
      return 'Auto-compaction failed; it will retry on the next turn, or start a new session using /new.'
  }
}
