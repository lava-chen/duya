/**
 * Token Budget Management
 * Tracks and manages token usage across system prompt, context, and reserved space
 */

import type { TokenBudget, TokenBudgetConfig } from './types.js'
import { DEFAULT_BUDGET_CONFIG } from './types.js'
import { estimateContextMessageTokens, estimateContextTextTokens } from '@duya/ai'

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
 * Estimate tokens for a single message.
 *
 * Delegates to the shared block-aware estimator in @duya/ai
 * (utils/context-estimate.ts) so compaction and the context ring can never
 * disagree about text volume. The shared implementation is language-aware
 * (CJK ≈ 2.5 chars/token, else ≈ 4), charges `thinking.thinking`,
 * `tool_use.input` and recursive `tool_result.content` at their real text
 * payload, images at a conservative floor, and never stringifies whole
 * content arrays — see the module doc there for the overcount history.
 */
export function estimateMessageTokens(message: { role: string; content: string | unknown }): number {
  const { content } = message;
  if (typeof content === 'string' || Array.isArray(content)) {
    return estimateContextMessageTokens({ ...message, content });
  }
  // Non-array, non-string content (legacy shapes): charge its serialized text.
  return estimateContextTextTokens(content == null ? '' : JSON.stringify(content));
}

/**
 * Estimate tokens for an array of messages
 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string | unknown }>): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}
