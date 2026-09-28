/**
 * Token Budget — immutable config holder for CompactionManager.
 *
 * Plan 577 §4: the single `maxTokens − reserve` line grew into a FIVE-value
 * budget model (four decision lines + the window they derive from):
 *
 *   contextWindow         — the model's physical window (= maxTokens)
 *   hardLimit             — the mid-loop overflow line (= full window)
 *   triggerHighWatermark  — proactive compaction fires above it (max − reserve)
 *   rearmLowWatermark     — the suppression STATE MACHINE line: the projection
 *                           must fall BELOW it before 'size' suppression is
 *                           lifted (default 0.75 × window)
 *   compactionTarget      — the compaction OPTIMIZATION GOAL only. It never
 *                           gates the state machine: a summarizer that lands
 *                           between target and rearm has re-armed the system
 *                           even though it missed the goal (default 0.6 × window)
 *
 * Token counting is done via computeContextEstimate() — no incremental tracking.
 */
import { estimateContextMessageTokens } from '@duya/ai'

export interface TokenBudgetConfig {
  /** Model context window (also the hardLimit). */
  maxTokens: number
  systemPromptTokens: number
  reservedTokens: number
  /** Explicit rearm override; default 0.75 × maxTokens. */
  rearmLowWatermark?: number
  /** Explicit compaction target override; default 0.6 × maxTokens. */
  compactionTarget?: number
}

export const DEFAULT_BUDGET_CONFIG: TokenBudgetConfig = {
  maxTokens: 200_000,
  systemPromptTokens: 8000,
  reservedTokens: 16_384,
}

/** Default rearm low-watermark as a fraction of the window (plan 577 §4
 *  example: 200K → rearm 150K). */
export const REARM_WINDOW_FRACTION = 0.75;
/** Default compaction target as a fraction of the window (200K → target 120K). */
export const TARGET_WINDOW_FRACTION = 0.6;

export class TokenBudgetManager {
  /** The model's physical window (plan 577 §4 naming; = maxTokens). */
  readonly contextWindow: number
  /** Mid-loop overflow line = full window. */
  readonly hardLimit: number
  /** Proactive compaction fires above this (= window − reserved). */
  readonly triggerHighWatermark: number
  /** 'size' suppression lifts only below this (hysteresis, plan 577 §4). */
  readonly rearmLowWatermark: number
  /** Compaction optimization goal — never a state-machine threshold. */
  readonly compactionTarget: number

  // ── Compatibility names (plan 517/552 era call sites) ────────────────────
  readonly maxTokens: number
  readonly systemPromptTokens: number
  readonly reservedTokens: number

  constructor(config: TokenBudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this.maxTokens = config.maxTokens
    this.systemPromptTokens = config.systemPromptTokens
    this.reservedTokens = config.reservedTokens
    this.contextWindow = config.maxTokens
    this.hardLimit = config.maxTokens
    this.triggerHighWatermark = config.maxTokens - config.reservedTokens
    this.rearmLowWatermark = Math.min(
      Math.max(
        0,
        config.rearmLowWatermark ?? Math.round(config.maxTokens * REARM_WINDOW_FRACTION),
      ),
      this.triggerHighWatermark,
    )
    this.compactionTarget = Math.min(
      Math.max(0, config.compactionTarget ?? Math.round(config.maxTokens * TARGET_WINDOW_FRACTION)),
      this.rearmLowWatermark,
    )
  }

  /** Tokens available for message history (max - system - reserved). */
  availableForHistory(): number {
    return this.maxTokens - this.systemPromptTokens - this.reservedTokens
  }
}

// ─── Token Estimation Utilities ────────────────────────────────────────────────

/**
 * Estimate tokens for a single message.
 * Delegates to the shared block-aware estimator in @duya/ai.
 */
export function estimateMessageTokens(message: { role: string; content: string | unknown }): number {
  return estimateContextMessageTokens(message as Parameters<typeof estimateContextMessageTokens>[0])
}

/**
 * Estimate tokens for an array of messages.
 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string | unknown }>): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}
