/**
 * Context Compaction System Types
 */

import type { Message, ToolUse } from '../types.js'

// Re-export for convenience
export type { Message, ToolUse }

// ============================================================
// Core Types
// ============================================================

/**
 * Compaction statistics. totalTokens is computed live via computeContextEstimate
 * so it always matches the renderer ring.
 */
export interface CompactionStats {
  totalTokens: number
  maxTokens: number
  /** Always 0 — kept for interface compatibility. */
  messageCount: 0
  /** Always 0 — kept for interface compatibility. */
  toolCallCount: 0
  sessionAge: number
  lastCompactionAt?: number
}

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  messages: Message[]
  tokensRemoved: number
  tokensRetained: number
  strategy: string
  /** Raw summary text (session_memory only). Used for memory flush. */
  summaryText?: string
}

/**
 * Compaction strategy. The threshold check (totalTokens > maxTokens - reserveTokens)
 * is handled by CompactionManager — strategies only implement compact().
 */
export interface CompactionStrategy {
  name: string
  compact(messages: Message[], stats: CompactionStats, options?: CompactOptions): Promise<CompactionResult>
}

// ============================================================
// Defaults
// ============================================================

export const DEFAULT_CONTEXT_WINDOW = 200_000

// ============================================================
// Options
// ============================================================

export interface CompactOptions {
  strategy?: string
  maxMessagesToKeep?: number
  customInstructions?: string
  /** 'auto' = gated by suppression; 'manual'/'emergency' = always run. */
  trigger?: 'auto' | 'manual' | 'emergency' | 'preflight_overflow' | 'model_switch'
  /** Transient seed from prefire (not used without prefire, kept for compat). */
  previousSummary?: string
  /**
   * Bypass strategy-level guards that would return the input unchanged
   * (Plan 495 G2 image-threshold trigger). The nothing-to-summarize
   * early return still applies.
   */
  force?: boolean
}
