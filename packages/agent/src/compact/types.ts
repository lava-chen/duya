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
 * Result of a compaction operation
 */
export interface CompactionResult {
  messages: Message[]
  tokensRemoved: number
  tokensRetained: number
  strategy: string
}

/**
 * Base interface for all compaction strategies
 */
export interface CompactionStrategy {
  name: string
  shouldCompact(stats: CompactionStats): boolean
  compact(messages: Message[], stats: CompactionStats): Promise<CompactionResult>
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
  // Micro Compact: 65% of max — light, early compression
  MICRO: 0.65,
  // Session Memory Compact: 78% of max — moderate compression
  SESSION_MEMORY: 0.78,
  // Snip Compact: 88% of max — aggressive compression (last resort before reactive)
  SNIP: 0.88,
  // Reactive: 90% of max — emergency, but still before API limit
  REACTIVE: 0.90,
} as const

/**
 * Circuit breaker: max consecutive compression failures per session
 */
export const MAX_CONSECUTIVE_FAILURES = 3

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
}
