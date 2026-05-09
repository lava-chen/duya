/**
 * Compaction Manager (Enhanced)
 * Orchestrates multiple compaction strategies and manages token budgets
 * with post-compact reinjection support
 */

import type { Message, ToolUse } from '../types.js'
import type {
  CompactionResult,
  CompactionStats,
  CompactionStrategy,
  CompactionEvent,
  TokenBudget,
  CompactOptions,
} from './types.js'
import { COMPACTION_THRESHOLDS, DEFAULT_CONTEXT_WINDOW } from './types.js'
import { TokenBudgetManager, estimateMessagesTokens } from './tokenBudget.js'
import {
  MicroCompactStrategy,
  SessionMemoryCompactStrategy,
  SnipCompactStrategy,
  ReactiveCompactStrategy,
} from './strategies/index.js'
import { PostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'
import type { FileChangeRecord as SessionMemoryFileChangeRecord } from './strategies/SessionMemoryCompactStrategy.js'

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
  /** Enable reactive compaction */
  enableReactive?: boolean
  /** Enable post-compact reinjection */
  enableReinjection?: boolean
  /** Reinjection configuration */
  reinjectionConfig?: Partial<ReinjectorConfig>
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
  private reactiveStrategy?: ReactiveCompactStrategy
  private reinjector?: PostCompactReinjector

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

    // Register default strategies
    this.registerDefaultStrategies()

    // Initialize reactive strategy if enabled
    if (config.enableReactive !== false) {
      this.reactiveStrategy = new ReactiveCompactStrategy()
      this.strategies.set('reactive', this.reactiveStrategy)
    }

    // Initialize post-compact reinjector if enabled
    if (config.enableReinjection) {
      this.reinjector = new PostCompactReinjector(config.reinjectionConfig)
    }
  }

  /**
   * Register default compaction strategies
   */
  private registerDefaultStrategies(): void {
    // Micro Compact (lightest)
    const micro = new MicroCompactStrategy()
    this.strategies.set('micro', micro)

    // Session Memory Compact (medium)
    const sessionMemory = new SessionMemoryCompactStrategy()
    this.strategies.set('session_memory', sessionMemory)

    // Snip Compact (heaviest - last resort)
    const snip = new SnipCompactStrategy()
    this.strategies.set('snip', snip)
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
    const stats = this.getStats()

    for (const [name, strategy] of this.strategies) {
      if (name === 'reactive') continue

      if (strategy.shouldCompact(stats)) {
        return true
      }
    }

    if (this.reactiveStrategy?.shouldCompact(stats)) {
      return true
    }

    return false
  }

  /**
   * Get the strategy to use for compaction
   */
  private selectStrategy(): CompactionStrategy {
    const stats = this.getStats()

    if (stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.SNIP) {
      return this.strategies.get('snip')!
    }

    if (stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.SESSION_MEMORY) {
      return this.strategies.get('session_memory')!
    }

    return this.strategies.get('micro')!
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
          console.warn('Post-compact reinjection failed:', reinjectError)
          // Continue without reinjection
        }
      }

      // Update state
      this.lastCompactionAt = Date.now()
      this.contextTokens = estimateMessagesTokens(finalMessages)
      this.budget.setContextTokens(this.contextTokens)
      this.consecutiveFailures = 0

      const result: EnhancedCompactionResult = {
        ...baseResult,
        messages: finalMessages,
        tokensRetained: estimateMessagesTokens(finalMessages),
        reinjection: reinjectionInfo,
      }

      this.emit({ type: 'compaction_complete', result })
      return result
    } catch (error) {
      this.consecutiveFailures++
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emit({ type: 'compaction_error', error: errorMessage })
      throw error
    }
  }

  /**
   * Execute reactive compaction (for emergency situations)
   */
  async reactiveCompact(
    messages: Message[],
    triggerError?: 'prompt_too_long' | 'context_length_exceeded' | 'manual_trigger',
  ): Promise<EnhancedCompactionResult> {
    if (!this.reactiveStrategy) {
      throw new Error('Reactive compaction is not enabled')
    }

    if (this.summarizer) {
      this.reactiveStrategy.setSummarizer(this.summarizer)
    }

    this.emit({ type: 'compaction_start', strategy: 'reactive' })

    try {
      const baseResult = await this.reactiveStrategy.compact(
        messages,
        this.getStats(),
        triggerError,
      )

      this.lastCompactionAt = Date.now()
      this.contextTokens = estimateMessagesTokens(baseResult.messages)
      this.budget.setContextTokens(this.contextTokens)
      this.consecutiveFailures = 0

      const result: EnhancedCompactionResult = {
        ...baseResult,
        tokensRetained: estimateMessagesTokens(baseResult.messages),
      }

      this.emit({ type: 'compaction_complete', result })
      return result
    } catch (error) {
      this.consecutiveFailures++
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
   * Register a file change handler for reactive compaction
   */
  onFileChange(handler: (path: string) => void): void {
    if (this.reactiveStrategy) {
      this.reactiveStrategy.registerFileChange('')
    }
  }

  /**
   * Register a tool call handler for reactive compaction
   */
  onToolCall(handler: (tool: ToolUse) => void): void {
    if (this.reactiveStrategy) {
      // Tool calls will be registered externally via registerToolCall
    }
  }

  /**
   * Register file change externally
   */
  registerFileChange(path: string): void {
    this.reactiveStrategy?.registerFileChange(path)
  }

  /**
   * Register tool call externally
   */
  registerToolCall(toolName: string): void {
    this.reactiveStrategy?.registerToolCall(toolName)
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
