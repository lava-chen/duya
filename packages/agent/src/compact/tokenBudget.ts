/**
 * Token Budget — immutable config holder for CompactionManager.
 *
 * Used only to expose maxTokens / systemPromptTokens / reservedTokens to callers.
 * Token counting is done via computeContextEstimate() — no incremental tracking.
 */
import { estimateContextMessageTokens } from '@duya/ai'

export interface TokenBudgetConfig {
  maxTokens: number
  systemPromptTokens: number
  reservedTokens: number
}

export const DEFAULT_BUDGET_CONFIG: TokenBudgetConfig = {
  maxTokens: 200_000,
  systemPromptTokens: 8000,
  reservedTokens: 16_384,
}

export class TokenBudgetManager {
  readonly maxTokens: number
  readonly systemPromptTokens: number
  readonly reservedTokens: number

  constructor(config: TokenBudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this.maxTokens = config.maxTokens
    this.systemPromptTokens = config.systemPromptTokens
    this.reservedTokens = config.reservedTokens
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
