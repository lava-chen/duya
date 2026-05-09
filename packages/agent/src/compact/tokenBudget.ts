/**
 * Token Budget Management
 * Tracks and manages token usage across system prompt, context, and reserved space
 */

import type { TokenBudget, TokenBudgetConfig } from './types.js'
import { DEFAULT_BUDGET_CONFIG } from './types.js'

/**
 * TokenBudget implementation
 */
export class TokenBudgetManager implements TokenBudget {
  maxTokens: number
  systemPromptTokens: number
  contextTokens: number
  reservedTokens: number

  private _reserved: number = 0

  constructor(config: TokenBudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this.maxTokens = config.maxTokens
    this.systemPromptTokens = config.systemPromptTokens
    this.reservedTokens = config.reservedTokens
    this.contextTokens = 0
  }

  /**
   * Get available tokens for context
   */
  getAvailable(): number {
    return this.maxTokens - this.systemPromptTokens - this.reservedTokens - this._reserved - this.contextTokens
  }

  /**
   * Reserve tokens (e.g., for pending tool results)
   */
  reserve(tokens: number): void {
    this._reserved += tokens
  }

  /**
   * Release previously reserved tokens
   */
  release(tokens: number): void {
    this._reserved = Math.max(0, this._reserved - tokens)
  }

  /**
   * Check if budget is exhausted
   */
  isExhausted(): boolean {
    return this.getAvailable() <= 0
  }

  /**
   * Get utilization percentage
   */
  getUtilization(): number {
    const used = this.systemPromptTokens + this.reservedTokens + this._reserved + this.contextTokens
    return (used / this.maxTokens) * 100
  }

  /**
   * Update context token count
   */
  setContextTokens(tokens: number): void {
    this.contextTokens = tokens
  }

  /**
   * Reset reserved tokens
   */
  reset(): void {
    this._reserved = 0
    this.contextTokens = 0
  }
}

// ============================================================
// Token Estimation Utilities
// ============================================================

/**
 * Regex for CJK characters (Chinese, Japanese, Korean).
 * CJK characters typically consume ~1-2 tokens per character in BPE tokenizers,
 * while ASCII/English text averages ~4 characters per token.
 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

/** Token ratio for CJK characters (conservative: 2.5 chars/token) */
const CJK_CHARS_PER_TOKEN = 2.5
/** Token ratio for non-CJK characters */
const ASCII_CHARS_PER_TOKEN = 4
/** Safety margin multiplier applied to estimates for proactive compression */
const SAFETY_MARGIN = 1.3

/**
 * Estimate tokens for a single message.
 * Uses language-aware estimation:
 * - CJK characters: ~2.5 chars/token (BPE tokenizers use more tokens for CJK)
 * - ASCII/English: ~4 chars/token
 */
export function estimateMessageTokens(message: { role: string; content: string | unknown }): number {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const cjkCount = (content.match(CJK_REGEX) || []).length
  const otherCount = content.length - cjkCount
  const cjkTokens = Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN)
  const otherTokens = Math.ceil(otherCount / ASCII_CHARS_PER_TOKEN)
  return cjkTokens + otherTokens
}

/**
 * Estimate tokens for an array of messages
 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string | unknown }>): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

/**
 * Estimate token count for raw text using language-aware formula
 */
export function roughTokenCountEstimation(text: string): number {
  const cjkCount = (text.match(CJK_REGEX) || []).length
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN) + Math.ceil(otherCount / ASCII_CHARS_PER_TOKEN)
}

/**
 * Apply safety margin to token estimate for proactive compression.
 * This accounts for tokenizer differences between our estimate and the actual API.
 */
export function withSafetyMargin(tokens: number): number {
  return Math.ceil(tokens * SAFETY_MARGIN)
}

/**
 * Check if messages exceed the given token budget (with safety margin).
 * Used for proactive context window management before sending to LLM API.
 */
export function exceedsBudget(
  messages: Array<{ role: string; content: string | unknown }>,
  budgetTokens: number,
  systemPromptTokens: number = 0,
  reservedTokens: number = 0,
): boolean {
  const estimated = estimateMessagesTokens(messages)
  const withMargin = withSafetyMargin(estimated)
  return withMargin + systemPromptTokens + reservedTokens > budgetTokens
}

/**
 * Create a new budget manager instance
 */
export function createTokenBudget(config?: Partial<TokenBudgetConfig>): TokenBudgetManager {
  return new TokenBudgetManager({
    ...DEFAULT_BUDGET_CONFIG,
    ...config,
  })
}
