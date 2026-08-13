/**
 * Compaction Manager (Enhanced)
 * Orchestrates multiple compaction strategies and manages token budgets
 * with post-compact reinjection support
 */

import type { Message } from '../types.js'
import type {
  CompactionResult,
  CompactionStats,
  CompactionStrategy,
  CompactionEvent,
  TokenBudget,
  CompactOptions,
} from './types.js'
import { DEFAULT_CONTEXT_WINDOW, COMPACTION_THRESHOLDS } from './types.js'
import { TokenBudgetManager, estimateMessagesTokens } from './tokenBudget.js'
import { logger } from '../utils/logger.js'
import { SessionMemoryCompactStrategy } from './strategies/index.js'
import { PostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'
import type { FileChangeRecord as SessionMemoryFileChangeRecord } from './strategies/SessionMemoryCompactStrategy.js'
import {
  classifyCompactFailure,
  CompactSuppression,
  isRetryableCompactFailure,
} from './compactErrors.js'
import { fitCompactedToBudget } from './historySanitize.js'

/**
 * Compute a stable fingerprint of the messages that must change when the
 * conversation content changes. Used to invalidate a cached prefire summary.
 */
export function fingerprintMessages(messages: readonly Message[]): string {
  let h = 2166136261
  const mix = (n: number) => {
    h ^= n
    h = Math.imul(h, 16777619)
  }
  for (const msg of messages) {
    mix(msg.id?.length ?? 0)
    // Fold a sample of the content into the hash so content edits invalidate it.
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((b) => (b as { type?: string }).type ?? '').join(',')
        : ''
    mix(content.length)
    for (let i = 0; i < content.length && i < 256; i += 1) {
      mix(content.charCodeAt(i))
    }
  }
  return `pf:${(h >>> 0).toString(36)}`
}

/**
 * Compaction Manager Configuration
 */
export interface CompactionManagerConfig {
  /** Maximum context window size */
  maxTokens?: number
  /** System prompt token allocation */
  systemPromptTokens?: number
  /** Reserved tokens for human interaction */
  reservedTokens?: number
  /** Enable post-compact reinjection */
  enableReinjection?: boolean
  /** Reinjection configuration */
  reinjectionConfig?: Partial<ReinjectorConfig>
  /** Number of recent tokens to keep (not summarize) */
  keepRecentTokens?: number
  /** Enable iterative summary updates */
  enableIterativeSummary?: boolean
}

/**
 * Compaction Manager Events
 */
export type CompactionManagerEvent =
  | { type: 'should_compact'; stats: CompactionStats }
  | { type: 'compaction_start'; strategy: string }
  | { type: 'compaction_complete'; result: CompactionResult }
  | { type: 'compaction_error'; error: string }
  | { type: 'reinject_complete'; files: number; skills: number }

/**
 * Enhanced compaction result with reinjection info
 */
export interface EnhancedCompactionResult extends CompactionResult {
  reinjection?: {
    filesReinjected: number
    skillsReinjected: number
    toolsRestored: number
    totalTokensAdded: number
  }
}

/**
 * Manages context compaction with multiple strategies and post-compact reinjection
 */
export class CompactionManager {
  private strategies: Map<string, CompactionStrategy> = new Map()
  private budget: TokenBudgetManager
  private contextTokens = 0
  private consecutiveFailures = 0
  private lastCompactionAt?: number
  private eventHandlers: Set<(event: CompactionManagerEvent) => void> = new Set()
  private summarizer?: (text: string, prompt: string) => Promise<string>
  private reinjector?: PostCompactReinjector
  private keepRecentTokens?: number
  private enableIterativeSummary: boolean
  private lastSummary?: string
  private suppression = new CompactSuppression()
  private prefireCache?: { fingerprint: string; summary: string }
  private memoryFlush?: (summary: string) => Promise<void>

  constructor(config: CompactionManagerConfig = {}) {
    const maxTokens = config.maxTokens ?? DEFAULT_CONTEXT_WINDOW
    const systemPromptTokens = config.systemPromptTokens ?? 8000
    const reservedTokens = config.reservedTokens ?? 5000

    // Initialize token budget
    this.budget = new TokenBudgetManager({
      maxTokens,
      systemPromptTokens,
      reservedTokens,
    })

    // Store config for strategy initialization
    this.keepRecentTokens = config.keepRecentTokens
    this.enableIterativeSummary = config.enableIterativeSummary ?? true

    // Register default strategies
    this.registerDefaultStrategies()

    // Initialize post-compact reinjector if enabled
    if (config.enableReinjection) {
      this.reinjector = new PostCompactReinjector(config.reinjectionConfig)
    }
  }

  /**
   * Register the single compaction strategy.
   */
  private registerDefaultStrategies(): void {
    const sessionMemory = new SessionMemoryCompactStrategy({
      keepRecentTokens: this.keepRecentTokens,
      previousSummary: this.enableIterativeSummary ? this.lastSummary : undefined,
    })
    this.strategies.set('session_memory', sessionMemory)
  }

  /**
   * Set the LLM summarizer function
   */
  setSummarizer(summarizer: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = summarizer

    // Inject summarizer into all strategies that need it
    for (const strategy of this.strategies.values()) {
      if ('setSummarizer' in strategy && typeof (strategy as any).setSummarizer === 'function') {
        ;(strategy as any).setSummarizer(summarizer)
      }
    }
  }

  /**
   * Register a memory-flush sink. After a compaction produces a summary, the
   * summary text is handed to `fn` so the host can persist important context to
   * the DUYA memory store before history is dropped. Best-effort: failures are
   * swallowed and never break the compaction path.
   */
  setMemoryFlushFn(fn: (summary: string) => Promise<void>): void {
    this.memoryFlush = fn
  }

  /**
   * Fire the memory-flush sink with the latest compaction summary (best-effort,
   * not awaited). No-op when no sink is configured.
   */
  private flushMemory(summary: string): void {
    if (!this.memoryFlush || !summary) return
    this.memoryFlush(summary).catch((err: unknown) => {
      logger.warn('Memory flush after compaction failed (best-effort)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Get current compaction stats
   */
  getStats(): CompactionStats {
    return {
      totalTokens: this.contextTokens,
      maxTokens: this.budget.maxTokens,
      messageCount: 0,
      toolCallCount: 0,
      sessionAge: this.lastCompactionAt ? Date.now() - this.lastCompactionAt : 0,
      lastCompactionAt: this.lastCompactionAt,
    }
  }

  /**
   * Get token budget
   */
  getBudget(): TokenBudget {
    return this.budget
  }

  /**
   * Update context token count
   */
  updateContextTokens(messages: Message[]): void {
    this.contextTokens = estimateMessagesTokens(messages)
    this.budget.setContextTokens(this.contextTokens)

    // Cache file state for potential reinjection
    if (this.reinjector) {
      this.reinjector.cacheFileState(messages)
    }
  }

  /**
   * Check if compaction should be triggered
   */
  shouldCompact(): boolean {
    if (this.suppression.isSuppressed('session')) return false
    const stats = this.getStats()
    const strategy = this.strategies.get('session_memory')
    return strategy?.shouldCompact(stats) ?? false
  }

  /**
   * Background prefire pass: generate an up-to-date summary for the current
   * messages and cache it, keyed by a content fingerprint. The cached summary
   * is injected as the previous summary on the next real compaction (pass 2),
   * so the waiting pass summarizes only recent deltas, not the whole history.
   * Fire-and-forget: failures return '' and are ignored.
   */
  async prefire(messages: Message[]): Promise<string> {
    const strategy = this.strategies.get('session_memory')
    if (!strategy || typeof (strategy as unknown as { summarizeConversation: unknown }).summarizeConversation !== 'function') {
      return ''
    }
    const fingerprint = fingerprintMessages(messages)
    if (this.prefireCache && this.prefireCache.fingerprint === fingerprint) {
      return this.prefireCache.summary
    }
    const summary = await (strategy as unknown as { summarizeConversation(m: Message[]): Promise<string> })
      .summarizeConversation(messages)
    if (summary) {
      this.prefireCache = { fingerprint, summary }
    }
    return summary
  }

  /**
   * Return the cached prefire summary if it still matches the current messages.
   */
  getPrefireSummary(messages: Message[]): string {
    if (!this.prefireCache) return ''
    if (this.prefireCache.fingerprint !== fingerprintMessages(messages)) return ''
    return this.prefireCache.summary
  }

  /**
   * Whether a background prefire pass should run now: usage is above the
   * prefire lead threshold but below the compaction threshold, and no valid
   * cached summary matches the current messages yet.
   */
  shouldPrefire(messages: Message[]): boolean {
    if (this.suppression.isSuppressed('session')) return false
    const stats = this.getStats()
    if (stats.totalTokens <= 0 || stats.maxTokens <= 0) return false
    const ratio = stats.totalTokens / stats.maxTokens
    if (ratio < COMPACTION_THRESHOLDS.PREFIRE) return false
    if (ratio >= COMPACTION_THRESHOLDS.SESSION_MEMORY) return false
    if (this.prefireCache && this.prefireCache.fingerprint === fingerprintMessages(messages)) return false
    return true
  }

  /**
   * Get the strategy to use for compaction.
   */
  private selectStrategy(): CompactionStrategy {
    return this.strategies.get('session_memory')!
  }

  /**
   * Execute compaction using the appropriate strategy with optional reinjection
   */
  async compact(
    messages: Message[],
    options?: CompactOptions & {
      workingDirectory?: string
      recentChanges?: SessionMemoryFileChangeRecord[]
      customReinjectContext?: string
    },
  ): Promise<EnhancedCompactionResult> {
    const strategyName = options?.strategy
    let strategy: CompactionStrategy

    if (strategyName && this.strategies.has(strategyName)) {
      strategy = this.strategies.get(strategyName)!
    } else {
      strategy = this.selectStrategy()
    }

    this.emit({ type: 'compaction_start', strategy: strategy.name })

    try {
      // Cache state before compaction if reinjection is enabled
      if (this.reinjector) {
        this.reinjector.cacheFileState(messages)
      }

      // Pass 2: if a background prefire summary is cached and still matches
      // the current messages, seed the strategy's previous summary so the
      // waiting pass summarizes only recent deltas, not the whole history.
      const prefireSummary = this.getPrefireSummary(messages)
      if (prefireSummary && typeof (strategy as unknown as { setPreviousSummary?: (s: string) => void }).setPreviousSummary === 'function') {
        ;(strategy as unknown as { setPreviousSummary(s: string): void }).setPreviousSummary(prefireSummary)
      }

      const baseResult = await strategy.compact(messages, this.getStats())

      // Apply post-compact reinjection if enabled
      let finalMessages = baseResult.messages
      let reinjectionInfo: EnhancedCompactionResult['reinjection'] | undefined

      if (this.reinjector && this.reinjector.getCacheStats().filesCached > 0) {
        try {
          const reinjectResult = await this.reinjector.reinject(baseResult.messages, {
            workingDirectory: options?.workingDirectory,
            recentChanges: options?.recentChanges,
            customContext: options?.customReinjectContext,
          })

          finalMessages = reinjectResult.messages
          reinjectionInfo = {
            filesReinjected: reinjectResult.filesReinjected.length,
            skillsReinjected: reinjectResult.skillsReinjected.length,
            toolsRestored: reinjectResult.toolsRestored.length,
            totalTokensAdded: reinjectResult.totalTokensAdded,
          }

          this.emit({
            type: 'reinject_complete',
            files: reinjectionInfo.filesReinjected,
            skills: reinjectionInfo.skillsReinjected,
          })
        } catch (reinjectError) {
          logger.warn('Post-compact reinjection failed', { error: reinjectError instanceof Error ? reinjectError.message : String(reinjectError) })
          // Continue without reinjection
        }
      }

      // Update state
      this.lastCompactionAt = Date.now()
      this.contextTokens = estimateMessagesTokens(finalMessages)
      this.budget.setContextTokens(this.contextTokens)
      this.consecutiveFailures = 0

      // Degrade gracefully if the compacted history still overflows the budget.
      const budgetTokens = this.budget.maxTokens - this.budget.reservedTokens
      if (this.contextTokens > budgetTokens) {
        finalMessages = fitCompactedToBudget(finalMessages, budgetTokens)
        this.contextTokens = estimateMessagesTokens(finalMessages)
        this.budget.setContextTokens(this.contextTokens)
      }

      // Store summary for iterative updates (if session_memory strategy was used)
      if (strategy.name === 'session_memory' && this.enableIterativeSummary) {
        // Extract summary from the summary message
        const summaryMessage = finalMessages.find(m => m.isCompactSummary)
        if (summaryMessage && typeof summaryMessage.content === 'string') {
          // Extract the summary text (remove the continuation instruction)
          const content = summaryMessage.content
          const summaryMatch = content.match(/The session memory below covers the earlier portion of the conversation\.\n\n([\s\S]+?)\n\nContinue the conversation/)
          if (summaryMatch) {
            this.lastSummary = summaryMatch[1]
          }
          // Persist important context to the memory store before history drops.
          if (this.lastSummary) {
            this.flushMemory(this.lastSummary)
          }
        }
      }

      const result: EnhancedCompactionResult = {
        ...baseResult,
        messages: finalMessages,
        tokensRetained: estimateMessagesTokens(finalMessages),
        reinjection: reinjectionInfo,
      }

      this.emit({ type: 'compaction_complete', result })
      return result
    } catch (error) {
      const kind = classifyCompactFailure(error)
      if (isRetryableCompactFailure(kind)) {
        this.consecutiveFailures++
      } else {
        // Deterministic / cancelled failures won't succeed on retry — suppress
        // auto-compaction for a window so the loop does not spin needlessly.
        this.suppression.suppress('session')
        this.consecutiveFailures = 0
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emit({ type: 'compaction_error', error: errorMessage })
      throw error
    }
  }

  /**
   * Cache skill context for post-compact reinjection
   */
  cacheSkillContext(skills: SkillContextEntry[]): void {
    this.reinjector?.cacheSkillContext(skills)
  }

  /**
   * Cache tool state for post-compact reinjection
   */
  cacheToolState(toolName: string, status: 'active' | 'completed' | 'error', output?: string): void {
    this.reinjector?.cacheToolState(toolName, { status, lastOutput: output })
  }

  /**
   * Add event handler
   */
  addEventHandler(handler: (event: CompactionManagerEvent) => void): void {
    this.eventHandlers.add(handler)
  }

  /**
   * Remove event handler
   */
  removeEventHandler(handler: (event: CompactionManagerEvent) => void): void {
    this.eventHandlers.delete(handler)
  }

  /**
   * Emit event to all handlers
   */
  private emit(event: CompactionManagerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Check if circuit breaker is triggered
   */
  isCircuitBreakerTriggered(): boolean {
    return this.consecutiveFailures >= 3
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0
  }

  /**
   * Get available strategies
   */
  getAvailableStrategies(): string[] {
    return Array.from(this.strategies.keys())
  }

  /**
   * Get the reinjector instance (for advanced usage)
   */
  getReinjector(): PostCompactReinjector | undefined {
    return this.reinjector
  }

  /**
   * Clear all caches (e.g., when starting a new session)
   */
  clearCache(): void {
    this.reinjector?.clearCache()
    this.contextTokens = 0
    this.lastCompactionAt = undefined
    this.consecutiveFailures = 0
  }
}

/**
 * Create a new compaction manager
 */
export function createCompactionManager(config?: CompactionManagerConfig): CompactionManager {
  return new CompactionManager(config)
}
