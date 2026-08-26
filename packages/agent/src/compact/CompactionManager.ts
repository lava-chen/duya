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
import { DEFAULT_CONTEXT_WINDOW, COMPACTION_THRESHOLDS, AUTO_COMPACT_COOLDOWN_MS, COMPACT_LOOP_DELTA_RATIO, COMPACT_LOOP_STRIKES, COMPACT_LOOP_BREAK_BLOCK_MS } from './types.js'
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
import { fitCompactedToBudget, validateCompactedHistory } from './historySanitize.js'

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
  | {
      type: 'compaction_loop_suspected'
      tokensBefore: number
      previousTokensBefore: number
      strikes: number
    }

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
  /**
   * True when the post-compaction projection still sits at or above the
   * compaction threshold. Callers/UI should treat this as a degraded state:
   * auto-compaction cannot make progress here (the loop breaker will block
   * further attempts) and the next real user turn is what changes the picture.
   */
  overThresholdAfterCompact?: boolean
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

  // ─── Loop guards (plan: compaction stability) ────────────────────────────
  /** Last prompt usage reported by the provider for a real request. Anchors
   *  shouldCompact on reality instead of the char heuristic when available. */
  private observedPromptTokens?: number
  /** Wall-clock block on proactive compaction (cooldown + loop breaker). */
  private proactiveBlockedUntil = 0
  /** tokensBefore of the last successful compact — loop-breaker baseline. */
  private lastCompactTokensBefore?: number
  /** Consecutive compactions whose tokensBefore grew less than the delta ratio. */
  private loopStrikes = 0

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
   * Update context token count from a message projection.
   *
   * This estimate is the FALLBACK input for compaction decisions. When the
   * host has observed real provider usage (see setObservedPromptTokens),
   * shouldCompact prefers that anchor — the char heuristic can drift far from
   * reality on tool-result-heavy sessions, which historically caused
   * premature and looping compactions.
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
   * Record the prompt volume (input + cache + output buffer) the provider
   * actually charged for the most recent request. Called by the agent after
   * each `result` event. A value of 0 or negative is ignored so gateway
   * glitches never poison the anchor.
   */
  setObservedPromptTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.observedPromptTokens = Math.floor(tokens)
    }
  }

  /**
   * Drop the observed-usage anchor. Called after a successful compaction:
   * the pre-compact anchor no longer describes the post-compact projection,
   * and decisions must fall back to fresh estimates until the next response.
   */
  clearObservedPromptTokens(): void {
    this.observedPromptTokens = undefined
  }

  /** Effective context size for threshold decisions: real provider usage when
   *  anchored, char-heuristic estimate otherwise. */
  private effectiveTotalTokens(): number {
    return this.observedPromptTokens ?? this.contextTokens
  }

  /** Whether proactive (auto) compaction currently respects a time block —
   *  either the post-compaction cooldown or the loop-breaker suppression. */
  private isProactivelyBlocked(now = Date.now()): boolean {
    return now < this.proactiveBlockedUntil
  }

  /** Consecutive near-zero-growth compactions recorded by the loop breaker.
   *  Observability for hosts/tests; saturation means auto-compaction is gated. */
  getLoopStrikes(): number {
    return this.loopStrikes
  }

  /**
   * Check if compaction should be triggered.
   *
   * Three guards sit in front of the raw threshold:
   * 1. Failure suppression (pre-existing CompactSuppression window).
   * 2. Proactive time block: cooldown after any successful compact plus the
   *    longer loop-breaker block — see AUTO_COMPACT_COOLDOWN_MS /
   *    COMPACT_LOOP_BREAK_BLOCK_MS.
   * 3. Anchoring: prefers the provider-reported prompt volume over the
   *    character-heuristic estimate so estimator drift alone cannot fire it.
   */
  shouldCompact(): boolean {
    if (this.suppression.isSuppressed('session')) return false
    if (this.isProactivelyBlocked()) return false
    const stats = this.getStats()
    const strategy = this.strategies.get('session_memory')
    if (!strategy) return false
    const effectiveTotal = this.effectiveTotalTokens()
    return strategy.shouldCompact({ ...stats, totalTokens: effectiveTotal })
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
    // Respect the same time blocks as shouldCompact: during a cooldown or a
    // loop-breaker block there is nothing worth pre-summarizing.
    if (this.isProactivelyBlocked()) return false
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
   * Pre-flight checks (plan 422 alignment with grok-build).
   *
   * grok runs four hard checks before invoking the summary sampler
   * (`compaction.rs:901+`) and aborts with a typed CompactFailure on
   * any failure. We mirror the most critical one (empty conversation)
   * at the manager layer so a fresh / unloaded worker surfaces an
   * explicit `compact:error` SSE event instead of the silent
   * `strategy: 'none'` no-op that masquerades as success in the UI.
   *
   * The other three (`simplified_messages.is_empty()`,
   * `system_message is None`, no system in simplified) live in the
   * strategy because they require splitting system vs conversation.
   */
  private preflight(messages: readonly Message[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Compaction failed: conversation is empty')
    }
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

    // Loop breaker gate: 'auto' compactions are refused while the strike
    // counter is saturated — compacting the same content again cannot make
    // progress and each attempt costs a summarizer call. Manual /compact and
    // emergency recovery bypass this gate by design.
    const trigger = options?.trigger ?? 'manual'
    if (trigger === 'auto' && this.loopStrikes >= COMPACT_LOOP_STRIKES) {
      logger.warn(
        `Compaction aborted by loop breaker: ${this.loopStrikes} consecutive compactions with <${Math.round(COMPACT_LOOP_DELTA_RATIO * 100)}% growth (tokensBefore baseline=${this.lastCompactTokensBefore ?? '?'})`,
        undefined,
        'Compaction',
      )
      return {
        messages: [],
        tokensRemoved: 0,
        tokensRetained: 0,
        strategy: 'none',
      }
    }

    this.emit({ type: 'compaction_start', strategy: strategy.name })

    try {
      // Cache state before compaction if reinjection is enabled
      if (this.reinjector) {
        this.reinjector.cacheFileState(messages)
      }

      // Pass 2: if a background prefire summary is cached and still matches
      // the current messages, hand it to the strategy as a *transient* seed.
      // The strategy uses it via options.previousSummary without mutating its
      // own config — so a shared strategy cannot leak a previous session's
      // summary into the next one (plan 422 fix).
      const prefireSummary = this.getPrefireSummary(messages)
      const compactOptions: CompactOptions = {
        ...(options ?? {}),
        ...(prefireSummary ? { previousSummary: prefireSummary } : {}),
      }

      // Plan 422: hard pre-flight before sampling so a malformed /
      // unloaded timeline throws a typed error instead of silently
      // returning strategy: 'none'.
      this.preflight(messages)

      const baseResult = await strategy.compact(messages, this.getStats(), compactOptions)

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

      // Loop guards: cooldown for every successful compact, cadence tracking
      // to detect "compacted but nothing changed" loops. See
      // AUTO_COMPACT_COOLDOWN_MS / COMPACT_LOOP_* in types.ts.
      const tokensBeforeNow = estimateMessagesTokens(messages)
      this.trackCompactionCadence(tokensBeforeNow, trigger)
      this.proactiveBlockedUntil = Math.max(
        this.proactiveBlockedUntil,
        Date.now() + AUTO_COMPACT_COOLDOWN_MS,
      )
      // The pre-compact usage anchor no longer describes the post-compact
      // projection; fall back to fresh estimates until the next response.
      this.clearObservedPromptTokens()

      // Plan 422: validate-after-sanitize fallback (grok build_compacted_history
      // alignment). sanitizeCompactedHistory strips orphan tool_results whose
      // tool_use is missing from the kept portion. If the strategy accidentally
      // produced something sanitize could not fully clean (e.g. an in-block
      // tool_use_id that resolves only after reordering), validate finds the
      // remaining orphans and we strip them with a logged warning. Without
      // this, the next LLM call would 400 on provider tool_use/tool_result
      // mismatch.
      {
        const violations = validateCompactedHistory(finalMessages)
        if (violations.length > 0) {
          logger.warn(
            'Compaction: post-validate still found orphan tool_results, stripping',
            { count: violations.length, ids: violations },
            'Compaction',
          )
          const toolUseIds = new Set<string>()
          for (const msg of finalMessages) {
            if (!Array.isArray(msg.content)) continue
            for (const block of msg.content) {
              if (block.type === 'tool_use' && typeof block.id === 'string') {
                toolUseIds.add(block.id)
              }
            }
          }
          finalMessages = finalMessages
            .map((msg) => {
              if (!Array.isArray(msg.content)) return msg
              const cleaned = msg.content.filter(
                (b) =>
                  !(b.type === 'tool_result' &&
                    typeof (b as { tool_use_id?: string }).tool_use_id === 'string' &&
                    !toolUseIds.has((b as { tool_use_id: string }).tool_use_id)),
              )
              return cleaned.length === msg.content.length ? msg : { ...msg, content: cleaned }
            })
            .filter((msg) =>
              !(Array.isArray(msg.content) && msg.content.length === 0),
            )
        }
      }

      // Degrade gracefully if the compacted history still overflows the budget.
      const budgetTokens = this.budget.maxTokens - this.budget.reservedTokens
      if (this.contextTokens > budgetTokens) {
        finalMessages = fitCompactedToBudget(finalMessages, budgetTokens)
        this.contextTokens = estimateMessagesTokens(finalMessages)
        this.budget.setContextTokens(this.contextTokens)
      }

      // Store summary for iterative updates (session_memory only). The strategy
      // populates result.summaryText directly so we never have to regex it back
      // out of the formatted summary message — the prompt template can change
      // without breaking the iterative update or memory-flush loop.
      if (strategy.name === 'session_memory' && this.enableIterativeSummary) {
        const raw = baseResult.summaryText
        if (typeof raw === 'string' && raw.length > 0) {
          this.lastSummary = raw
          // Persist important context to the memory store before history drops.
          this.flushMemory(raw)
        }
      }

      // Post-compact self-check: if the FINAL projection (after sanitize and
      // budget fitting) still sits at or above the compaction threshold,
      // record it loudly instead of silently letting the next turn re-trigger
      // (historical loop cause). Cooldown + loop breaker keep this from
      // spinning; the flag surfaces the degraded state to callers/UI.
      const overThresholdAfterCompact =
        estimateMessagesTokens(finalMessages) >=
        this.budget.maxTokens * COMPACTION_THRESHOLDS.SESSION_MEMORY
      if (overThresholdAfterCompact) {
        logger.warn(
          'Compaction finished but projection is still at/above threshold',
          { contextTokens: this.contextTokens, maxTokens: this.budget.maxTokens },
          'Compaction',
        )
      }

      const result: EnhancedCompactionResult = {
        ...baseResult,
        messages: finalMessages,
        tokensRetained: estimateMessagesTokens(finalMessages),
        reinjection: reinjectionInfo,
        overThresholdAfterCompact,
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
   * Track cadence between consecutive compactions and arm the loop breaker.
   *
   * A compaction whose input size grew less than COMPACT_LOOP_DELTA_RATIO since
   * the previous one is counted as a loop strike (only for 'auto' triggers);
   * COMPACT_LOOP_STRIKES consecutive strikes block proactive compaction for
   * COMPACT_LOOP_BREAK_BLOCK_MS and emit `compaction_loop_suspected`. Meaningful
   * growth resets the strikes.
   */
  private trackCompactionCadence(tokensBefore: number, trigger: 'auto' | 'manual' | 'emergency'): void {
    const previous = this.lastCompactTokensBefore
    this.lastCompactTokensBefore = tokensBefore
    if (previous === undefined || previous <= 0 || trigger !== 'auto') return

    const growth = (tokensBefore - previous) / previous
    if (growth >= COMPACT_LOOP_DELTA_RATIO) {
      this.loopStrikes = 0
      return
    }

    this.loopStrikes += 1
    if (this.loopStrikes >= COMPACT_LOOP_STRIKES) {
      this.proactiveBlockedUntil = Math.max(
        this.proactiveBlockedUntil,
        Date.now() + COMPACT_LOOP_BREAK_BLOCK_MS,
      )
      logger.warn(
        'Compaction loop detected: suppressing auto-compaction',
        {
          strikes: this.loopStrikes,
          previousTokensBefore: previous,
          tokensBefore,
          blockedForMs: COMPACT_LOOP_BREAK_BLOCK_MS,
        },
        'Compaction',
      )
      this.emit({
        type: 'compaction_loop_suspected',
        tokensBefore,
        previousTokensBefore: previous,
        strikes: this.loopStrikes,
      })
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
    this.observedPromptTokens = undefined
    this.proactiveBlockedUntil = 0
    this.lastCompactTokensBefore = undefined
    this.loopStrikes = 0
  }
}

/**
 * Create a new compaction manager
 */
export function createCompactionManager(config?: CompactionManagerConfig): CompactionManager {
  return new CompactionManager(config)
}
