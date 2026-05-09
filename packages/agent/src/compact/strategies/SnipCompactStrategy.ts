/**
 * Snip Compact Strategy
 * Simple truncation strategy that keeps only the most recent messages
 * Used as a last resort when other strategies fail or context is nearly full
 */

import type { CompactionResult, CompactionStats, CompactionStrategy, Message } from '../types.js'
import { COMPACTION_THRESHOLDS } from '../types.js'
import { estimateMessagesTokens } from '../tokenBudget.js'

/**
 * Configuration for Snip Compact
 */
export interface SnipCompactConfig {
  /** Keep the most recent N messages */
  maxMessagesToKeep: number
}

/**
 * Snip Compact Strategy - Direct truncation for emergency situations
 *
 * Strategy:
 * - Keep only the most recent N messages
 * - Discard all older messages
 * - No summarization
 * - Threshold: 95% of max tokens (last resort)
 */
export class SnipCompactStrategy implements CompactionStrategy {
  name = 'snip'
  private config: SnipCompactConfig

  constructor(config: Partial<SnipCompactConfig> = {}) {
    this.config = {
      maxMessagesToKeep: config.maxMessagesToKeep ?? 10,
    }
  }

  /**
   * Check if compaction should be triggered
   * Threshold: 95% of max tokens (last resort)
   */
  shouldCompact(stats: CompactionStats): boolean {
    return stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.SNIP
  }

  /**
   * Execute snip compaction - simple truncation
   */
  async compact(messages: Message[], stats: CompactionStats): Promise<CompactionResult> {
    const SYSTEM_MESSAGE_PREFIXES = ['system', 'instruction', 'You are', 'You are a', 'This session is being continued']

    // Separate system messages from conversation
    const systemMessages: Message[] = []
    const conversationMessages: Message[] = []

    for (const msg of messages) {
      const isSystem =
        msg.role === 'system' ||
        SYSTEM_MESSAGE_PREFIXES.some(prefix =>
          typeof msg.content === 'string' && msg.content.startsWith(prefix)
        )

      if (isSystem) {
        systemMessages.push(msg)
      } else {
        conversationMessages.push(msg)
      }
    }

    // Calculate tokens removed
    const tokensBefore = estimateMessagesTokens(messages)

    // Keep system messages and most recent N conversation messages
    const recentMessages = conversationMessages.slice(-this.config.maxMessagesToKeep)

    // Build compressed history
    const compressedMessages: Message[] = [
      ...systemMessages,
      ...recentMessages,
    ]

    // Calculate tokens retained
    const tokensRetained = estimateMessagesTokens(compressedMessages)
    const tokensRemoved = tokensBefore - tokensRetained

    return {
      messages: compressedMessages,
      tokensRemoved,
      tokensRetained,
      strategy: this.name,
    }
  }
}

/**
 * Create snip compact strategy
 */
export function createSnipCompactStrategy(config?: Partial<SnipCompactConfig>): SnipCompactStrategy {
  return new SnipCompactStrategy(config)
}
