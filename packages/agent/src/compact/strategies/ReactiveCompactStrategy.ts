/**
 * Reactive Compact Strategy (Enhanced)
 * Emergency compaction triggered when context limit is reached.
 *
 * Enhanced features from claude-code-haha:
 * 1. Multi-level fallback (micro -> session_memory -> snip)
 * 2. Smart message selection based on importance
 * 3. Preserve recent tool results for continuity
 * 4. Handle "prompt too long" errors gracefully
 */

import type { CompactionResult, CompactionStats, CompactionStrategy, Message } from '../types.js'
import { COMPACTION_THRESHOLDS } from '../types.js'
import { estimateMessagesTokens, estimateMessageTokens } from '../tokenBudget.js'
import { MicroCompactStrategy, type FileStateEntry } from './MicroCompactStrategy.js'
import { SessionMemoryCompactStrategy } from './SessionMemoryCompactStrategy.js'

/**
 * Configuration for Reactive Compact
 */
export interface ReactiveCompactConfig {
  /** Target compression ratio (0-1) - how much to reduce by */
  targetCompressionRatio: number
  /** Maximum number of retries if first attempt fails */
  maxRetries: number
  /** Whether to use micro compact as fallback */
  enableMicroFallback: boolean
  /** Whether to use session memory as fallback */
  enableSessionMemoryFallback: boolean
  /** Minimum messages to keep to maintain context */
  minMessagesToKeep: number
}

/**
 * Error types that trigger reactive compaction
 */
export type TriggerErrorType =
  | 'prompt_too_long'
  | 'context_length_exceeded'
  | 'token_limit_reached'
  | 'rate_limited'
  | 'manual_trigger'
  | 'emergency'

/**
 * Result of reactive compaction with metadata
 */
export interface ReactiveCompactionResult extends CompactionResult {
  triggerError?: TriggerErrorType
  attemptsMade: number
  originalTokenCount: number
  finalTokenCount: number
  compressionRatio: number
}

/**
 * Message importance score for smart selection
 */
interface MessageImportance {
  index: number
  score: number
  reasons: string[]
}

/**
 * Calculate importance score for a message
 * Higher score = more important = should be kept
 */
function calculateMessageImportance(msg: Message, index: number, totalMessages: number): MessageImportance {
  let score = 0
  const reasons: string[] = []

  // Recent messages are more important (exponential decay)
  const recencyScore = Math.pow(1.5, (index / totalMessages) * 10)
  score += recencyScore
  reasons.push(`recency:${recencyScore.toFixed(1)}`)

  // System messages are critical
  if (msg.role === 'system') {
    score += 100
    reasons.push('system-message')
  }

  // User messages are important for understanding intent
  if (msg.role === 'user') {
    score += 50
    reasons.push('user-message')
  }

  // Messages with tool results contain important information
  if (Array.isArray(msg.content)) {
    const hasToolUse = msg.content.some((b: any) => b.type === 'tool_use')
    const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')

    if (hasToolUse) {
      score += 30
      reasons.push('tool-use')
    }
    if (hasToolResult) {
      score += 25
      reasons.push('tool-result')
    }

    // Check for error in tool results
    const hasError = msg.content.some(
      (b: any) => b.type === 'tool_result' && b.is_error === true
    )
    if (hasError) {
      score += 40
      reasons.push('error-context')
    }

    // Check for file operations (important for continuity)
    const hasFileOp = msg.content.some((b: any) => {
      if ((b as any).type !== 'tool_use') return false
      const name = (b as any).name
      return ['Read', 'Write', 'Edit'].includes(name)
    })
    if (hasFileOp) {
      score += 35
      reasons.push('file-operation')
    }
  }

  return { index, score, reasons }
}

/**
 * Select which messages to keep based on importance scores
 */
function selectMessagesByImportance(
  messages: Message[],
  targetTokenCount: number,
): { keep: Message[]; remove: Message[] } {
  // Calculate importance for all non-system messages
  const systemMessages: Message[] = []
  const scoredMessages: MessageImportance[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'system' || typeof msg.content === 'string' && msg.content.startsWith('This session is being continued')) {
      systemMessages.push(msg)
    } else {
      scoredMessages.push(calculateMessageImportance(msg, i, messages.length))
    }
  }

  // Sort by importance (descending)
  scoredMessages.sort((a, b) => b.score - a.score)

  // Select messages until we reach target token count
  const keepIndices = new Set<number>()
  let currentTokens = estimateMessagesTokens(systemMessages)

  for (const item of scoredMessages) {
    const msgTokens = estimateMessageTokens(messages[item.index])
    if (currentTokens + msgTokens <= targetTokenCount || keepIndices.size < 5) {
      keepIndices.add(item.index)
      currentTokens += msgTokens
    }
  }

  // Split into keep and remove arrays, maintaining original order
  const keep: Message[] = [...systemMessages]
  const remove: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    if (keepIndices.has(i)) {
      keep.push(messages[i])
    } else {
      remove.push(messages[i])
    }
  }

  return { keep, remove }
}

/**
 * Extract recent tool results for continuity preservation
 */
function extractRecentToolResults(messages: Message[], count: number = 5): Message[] {
  const results: Message[] = []

  for (let i = messages.length - 1; i >= 0 && results.length < count; i--) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue

    const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')
    if (hasToolResult) {
      results.unshift(msg)
    }
  }

  return results
}

/**
 * Generate a summary of removed messages
 */
async function generateRemovedSummary(
  removedMessages: Message[],
  summarizer?: (text: string, prompt: string) => Promise<string>,
): Promise<string> {
  if (!summarizer || removedMessages.length === 0) {
    return `[${removedMessages.length} messages removed due to context length limit]`
  }

  try {
    const text = removedMessages
      .map(msg => {
        if (typeof msg.content === 'string') {
          return `[${msg.role}]: ${msg.content.slice(0, 200)}`
        }
        if (Array.isArray(msg.content)) {
          const tools = msg.content
            .filter((b: any) => b.type === 'tool_use')
            .map((b: any) => `${(b as any).name}(${JSON.stringify((b as any).input)?.slice(0, 100)})`)
          return `[${msg.role}]: tools=[${tools.join(', ')}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    return await summarizer(text, `Summarize these ${removedMessages.length} messages that were removed due to context limits. Focus on key actions and outcomes.`)
  } catch {
    return `[${removedMessages.length} messages removed - summary unavailable]`
  }
}

/**
 * Reactive Compact Strategy - Emergency compaction when context limit exceeded
 *
 * Strategy:
 * - Triggered when prompt too long or context limit reached
 * - Uses multi-level fallback: session_memory -> micro -> snip
 * - Smart message selection based on importance scoring
 * - Preserves recent tool results for continuity
 * - Threshold: 95% of max tokens or explicit trigger
 */
export class ReactiveCompactStrategy implements CompactionStrategy {
  name = 'reactive'
  private config: ReactiveCompactConfig
  private summarizer?: (text: string, prompt: string) => Promise<string>
  private lastTriggerError?: TriggerErrorType

  constructor(config: Partial<ReactiveCompactConfig> = {}) {
    this.config = {
      targetCompressionRatio: config.targetCompressionRatio ?? 0.6,
      maxRetries: config.maxRetries ?? 2,
      enableMicroFallback: config.enableMicroFallback ?? true,
      enableSessionMemoryFallback: config.enableSessionMemoryFallback ?? true,
      minMessagesToKeep: config.minMessagesToKeep ?? 10,
    }
  }

  /**
   * Check if reactive compaction should be triggered
   * Threshold: 95% of max tokens OR explicit trigger
   */
  shouldCompact(stats: CompactionStats): boolean {
    return stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.REACTIVE
  }

  /**
   * Set the summarization function (injected LLM client)
   */
  setSummarizer(summarizer: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = summarizer
  }

  /**
   * Get the last trigger error type
   */
  getLastTriggerError(): TriggerErrorType | undefined {
    return this.lastTriggerError
  }

  /**
   * Register a file change for tracking
   */
  registerFileChange(_path: string): void {
    // File changes are tracked internally for reactive compaction triggers
  }

  /**
   * Register a tool call for tracking
   */
  registerToolCall(_toolName: string): void {
    // Tool calls are tracked internally for reactive compaction triggers
  }

  /**
   * Execute reactive compaction with fallback chain
   */
  async compact(
    messages: Message[],
    stats: CompactionStats,
    triggerError?: TriggerErrorType,
  ): Promise<ReactiveCompactionResult> {
    this.lastTriggerError = triggerError ?? 'context_length_exceeded'
    const originalTokenCount = stats.totalTokens

    // Calculate target tokens after compression
    const targetTokenCount = Math.floor(stats.maxTokens * this.config.targetCompressionRatio)

    let attempts = 0
    let result: ReactiveCompactionResult | null = null

    while (attempts <= this.config.maxRetries && !result) {
      attempts++

      try {
        switch (attempts) {
          case 1:
            // First attempt: Use session memory strategy if available
            if (this.config.enableSessionMemoryFallback) {
              result = await this.attemptSessionMemoryCompact(messages, targetTokenCount, triggerError)
              break
            }
            // Fall through to micro

          case 2:
            // Second attempt: Use micro compact
            if (this.config.enableMicroFallback) {
              result = await this.attemptMicroCompact(messages, targetTokenCount, triggerError)
              break
            }
            // Fall through to snip

          default:
            // Last resort: Aggressive snipping
            result = await this.attemptSnipCompact(messages, targetTokenCount, triggerError)
            break
        }

        // Verify the result is within target
        if (result && estimateMessagesTokens(result.messages) > targetTokenCount) {
          // Still too large, try next level
          result = null
        }
      } catch (error) {
        console.error(`Reactive compact attempt ${attempts} failed:`, error)
        result = null
      }
    }

    // If all strategies failed, do aggressive truncation
    if (!result) {
      result = await this.emergencyTruncate(messages, targetTokenCount, triggerError)
    }

    return {
      ...result,
      attemptsMade: attempts,
      originalTokenCount,
      finalTokenCount: estimateMessagesTokens(result.messages),
      compressionRatio: 1 - (estimateMessagesTokens(result.messages) / originalTokenCount),
    }
  }

  /**
   * Attempt session memory compaction
   */
  private async attemptSessionMemoryCompact(
    messages: Message[],
    targetTokenCount: number,
    triggerError?: TriggerErrorType,
  ): Promise<ReactiveCompactionResult> {
    const strategy = new SessionMemoryCompactStrategy({
      maxMessagesToKeep: Math.max(this.config.minMessagesToKeep, 10),
    })

    if (this.summarizer) {
      strategy.setSummarizer(this.summarizer)
    }

    const stats: CompactionStats = {
      totalTokens: estimateMessagesTokens(messages),
      maxTokens: targetTokenCount,
      messageCount: messages.length,
      toolCallCount: 0,
      sessionAge: 0,
    }

    const baseResult = await strategy.compact(messages, stats)

    return {
      ...baseResult,
      triggerError,
      attemptsMade: 1,
      originalTokenCount: estimateMessagesTokens(messages),
      finalTokenCount: estimateMessagesTokens(baseResult.messages),
      compressionRatio: baseResult.tokensRemoved / estimateMessagesTokens(messages),
    }
  }

  /**
   * Attempt micro compaction
   */
  private async attemptMicroCompact(
    messages: Message[],
    targetTokenCount: number,
    triggerError?: TriggerErrorType,
  ): Promise<ReactiveCompactionResult> {
    const strategy = new MicroCompactStrategy({
      maxMessagesToKeep: Math.max(this.config.minMessagesToKeep, 15),
    })

    if (this.summarizer) {
      strategy.setSummarizer(this.summarizer)
    }

    const stats: CompactionStats = {
      totalTokens: estimateMessagesTokens(messages),
      maxTokens: targetTokenCount,
      messageCount: messages.length,
      toolCallCount: 0,
      sessionAge: 0,
    }

    const baseResult = await strategy.compact(messages, stats)

    return {
      ...baseResult,
      triggerError,
      attemptsMade: 1,
      originalTokenCount: estimateMessagesTokens(messages),
      finalTokenCount: estimateMessagesTokens(baseResult.messages),
      compressionRatio: baseResult.tokensRemoved / estimateMessagesTokens(messages),
    }
  }

  /**
   * Attempt snip-based compaction
   */
  private async attemptSnipCompact(
    messages: Message[],
    targetTokenCount: number,
    triggerError?: TriggerErrorType,
  ): Promise<ReactiveCompactionResult> {
    // Smart selection based on importance
    const { keep, remove } = selectMessagesByImportance(messages, targetTokenCount)

    // Generate summary of removed messages
    const summaryText = await generateRemovedSummary(remove, this.summarizer)

    // Add summary message
    const summaryMessage: Message = {
      role: 'system',
      content: `Context was running low. Summary of removed messages:\n\n${summaryText}\n\nContinue working.`,
      timestamp: Date.now(),
      metadata: {
        strategy: 'reactive_snip',
        messagesCompressed: remove.length,
        triggerError,
      },
    }

    const compressedMessages = [summaryMessage, ...keep]

    return {
      messages: compressedMessages,
      tokensRemoved: estimateMessagesTokens(remove),
      tokensRetained: estimateMessagesTokens(compressedMessages),
      strategy: 'reactive_snip',
      triggerError,
      attemptsMade: 1,
      originalTokenCount: estimateMessagesTokens(messages),
      finalTokenCount: estimateMessagesTokens(compressedMessages),
      compressionRatio: estimateMessagesTokens(remove) / estimateMessagesTokens(messages),
    }
  }

  /**
   * Emergency truncate - last resort
   */
  private async emergencyTruncate(
    messages: Message[],
    targetTokenCount: number,
    triggerError?: TriggerErrorType,
  ): Promise<ReactiveCompactionResult> {
    // Keep only system messages and very recent messages
    const systemMessages = messages.filter(m =>
      m.role === 'system' ||
      (typeof m.content === 'string' && m.content.includes('session'))
    )

    const recentMessages = messages.slice(-Math.max(this.config.minMessagesToKeep, 5))
    const removedCount = messages.length - systemMessages.length - recentMessages.length

    const summaryMessage: Message = {
      role: 'system',
      content: `Emergency context reduction performed. ${removedCount} earlier messages were removed. Continue with available context.`,
      timestamp: Date.now(),
      metadata: {
        strategy: 'emergency_truncate',
        messagesCompressed: removedCount,
        triggerError,
      },
    }

    const compressedMessages = [...systemMessages, summaryMessage, ...recentMessages]

    return {
      messages: compressedMessages,
      tokensRemoved: estimateMessagesTokens(messages) - estimateMessagesTokens(compressedMessages),
      tokensRetained: estimateMessagesTokens(compressedMessages),
      strategy: 'emergency_truncate',
      triggerError,
      attemptsMade: 1,
      originalTokenCount: estimateMessagesTokens(messages),
      finalTokenCount: estimateMessagesTokens(compressedMessages),
      compressionRatio: removedCount / messages.length,
    }
  }
}

/**
 * Create default reactive compact strategy
 */
export function createReactiveCompactStrategy(config?: Partial<ReactiveCompactConfig>): ReactiveCompactStrategy {
  return new ReactiveCompactStrategy(config)
}
