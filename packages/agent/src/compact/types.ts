/**
 * Context Compaction System Types
 * Defines interfaces for compression strategies, token budgets, and compaction statistics
 */

import type { Message, ToolUse } from '../types.js';

// Re-export for convenience
export type { Message, ToolUse };

// ============================================================
// Core Compaction Types
// ============================================================

/**
 * Statistics about the current context state
 */
export interface CompactionStats {
  totalTokens: number
  maxTokens: number
  messageCount: number
  toolCallCount: number
  sessionAge: number
  lastCompactionAt?: number
}

/**
 * Result of a compaction operation.
 *
 * `summaryText` carries the raw summary text the strategy produced (when it
 * applies — e.g. `session_memory`). The manager uses this to drive iterative
 * updates and the memory-flush sink without having to parse the summary out
 * of the formatted summary message — that round-trip is fragile and would
 * break every time the prompt template changed.
 */
export interface CompactionResult {
  messages: Message[]
  tokensRemoved: number
  tokensRetained: number
  strategy: string
  /**
   * The raw summary text the strategy produced (session_memory only).
   * The manager stores it for iterative compaction and the memory flush;
   * the visible summary message embedded in `messages` is the formatted
   * version of this same text.
   */
  summaryText?: string
}

/**
 * Base interface for all compaction strategies
 */
export interface CompactionStrategy {
  name: string
  shouldCompact(stats: CompactionStats): boolean
  /**
   * Run a compaction pass. The optional `options.previousSummary` is a
   * transient seed for two-pass prefire; strategies that accept it should
   * prefer it over their persistent `config.previousSummary` without
   * mutating the config (so a shared strategy cannot leak across sessions).
   */
  compact(
    messages: Message[],
    stats: CompactionStats,
    options?: CompactOptions,
  ): Promise<CompactionResult>
}

// ============================================================
// Token Budget Types
// ============================================================

/**
 * Configuration for token budget allocation
 */
export interface TokenBudgetConfig {
  maxTokens: number
  systemPromptTokens: number
  reservedTokens: number
}

/**
 * Token budget tracking interface
 */
export interface TokenBudget {
  maxTokens: number
  systemPromptTokens: number
  contextTokens: number
  reservedTokens: number

  getAvailable(): number
  reserve(tokens: number): void
  release(tokens: number): void
  isExhausted(): boolean
  getUtilization(): number
}

/**
 * Default context window size for Claude models (200K)
 */
export const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * Default budget for Claude 200K context.
 * maxTokens should match DEFAULT_CONTEXT_WINDOW for consistent threshold calculations.
 * System prompt and reserved tokens are subtracted from the budget at runtime.
 */
export const DEFAULT_BUDGET_CONFIG: TokenBudgetConfig = {
  maxTokens: DEFAULT_CONTEXT_WINDOW,
  systemPromptTokens: 8000,
  reservedTokens: 5000,
}

// ============================================================
// Strategy Configuration
// ============================================================

/**
 * Thresholds for triggering different compaction strategies.
 * Lowered from previous values to enable proactive compression before
 * the API rejects the request. The safety margin in token estimation
 * (1.3x) provides additional buffer.
 */
export const COMPACTION_THRESHOLDS = {
  // Session Memory Compact: 78% of max — single strategy
  SESSION_MEMORY: 0.78,
  // Prefire lead: begin the background summary pass at 68% so a fresh
  // summary is ready before compaction (85%-equivalent) fires.
  PREFIRE: 0.68,
} as const

/**
 * Minimum wall-clock interval between two proactive auto-compactions.
 *
 * Guards against the compaction loop observed on session 5e930b44 (2026-08-26):
 * a post-compaction projection that still reads over the threshold (estimator
 * drift, reinjection, hook re-projection) re-triggered compaction every
 * ~50-90s, burning one summarizer call per turn while regenerating an
 * identical summary. Emergency compaction on `context_length_exceeded` and
 * manual /compact bypass this cooldown by design — they call compact()
 * directly, not through shouldCompact().
 */
export const AUTO_COMPACT_COOLDOWN_MS = 120_000

/**
 * Relative growth in `tokensBefore` two consecutive compactions must show to
 * be considered independent work. Below this delta, the second compaction is
 * counted as a loop strike; two strikes suppress auto-compaction for
 * LOOP_BREAK_BLOCK_MS because compacting the same content again cannot make
 * progress.
 */
export const COMPACT_LOOP_DELTA_RATIO = 0.10

// Note: the cooldown/loop-strikes/circuit-breaker constants that used to live
// here were removed when CompactionManager was aligned with grok's 5-state
// suppression machine (see compactErrors.ts `SuppressState` and the grok
// reference at `xai-grok-shell/src/session/compaction.rs:444-810`). Each
// grok-aligned state has its own clear trigger:
//   - SUPPRESS_TURN         cleared on turn start
//   - SUPPRESS_STICKY       cleared on a context-budget change (successful
//                           compaction, rewind, or model switch)
//   - SUPPRESS_UNTIL_SUCCESS cleared on the next healthy LLM 200 response
//   - SUPPRESS_AUTH         cleared on token refresh / login
// A single rolling cooldown window cannot express these scopes — a single
// 10-minute block after a Size failure is the wrong shape for an auth
// failure (which only resolves on login) or a credit failure (which only
// resolves on next LLM 200).

// ============================================================
// Compaction Event Types
// ============================================================

/**
 * Events emitted during compaction process
 */
export type CompactionEvent =
  | { type: 'compaction_start'; strategy: string }
  | { type: 'compaction_progress'; percent: number }
  | { type: 'compaction_complete'; result: CompactionResult }
  | { type: 'compaction_error'; error: string }

/**
 * Options for manual compaction
 */
export interface CompactOptions {
  strategy?: string
  maxMessagesToKeep?: number
  customInstructions?: string
  /**
   * Who initiated this compaction. `'auto'` compactions are subject to the
   * cooldown and loop-breaker guards; `'manual'` (/compact) and `'emergency'`
   * (context_length_exceeded recovery) always run.
   */
  trigger?:
    | 'auto'
    | 'manual'
    | 'emergency'
    | 'preflight_overflow'
    | 'model_switch'
  /**
   * Transient seed for the next compaction, supplied by the manager's
   * prefire pipeline. Strategies prefer this over their persistent
   * `previousSummary` so the seed is never persisted to the strategy.
   */
  previousSummary?: string
}
