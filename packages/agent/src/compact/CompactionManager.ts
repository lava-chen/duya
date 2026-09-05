/**
 * Compaction Manager — Pi/grok-aligned, anchor-based, flat.
 *
 * Design:
 * - Token counting: always via computeContextEstimate() (same as renderer ring).
 *   Priority: observedPromptTokens (API anchor) > computeContextEstimate > 0.
 * - Threshold: totalTokens > maxTokens - reserveTokens  (Pi style).
 * - Suppression: lightweight — remember the last failure type and when to retry.
 *   No 5-state machine. Failures: auth (cleared on login), size (cleared on
 *   compaction), other (cleared on next turn).
 * - No prefire. No iterative summary. No suppression cooldown constants.
 * - Flat delegation: one class, one shouldCompact() call.
 */

import type { Message } from '../types.js'
import type { CompactionResult, CompactionStats, CompactionStrategy, CompactOptions } from './types.js'
import { DEFAULT_CONTEXT_WINDOW } from './types.js'
import { TokenBudgetManager } from './tokenBudget.js'
import { computeContextEstimate, type ContextEstimateMessage } from '@duya/ai'
import { logger } from '../utils/logger.js'
import { SessionMemoryCompactStrategy } from './strategies/index.js'
import { PostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'
import type { FileChangeRecord as SessionMemoryFileChangeRecord } from './strategies/SessionMemoryCompactStrategy.js'
import { fitCompactedToBudget, validateCompactedHistory } from './historySanitize.js'

// ─── Adapters ─────────────────────────────────────────────────────────────────

function toContextEstimateMessage(msg: Message): ContextEstimateMessage {
  return {
    role: msg.role,
    content: msg.content as string | unknown[],
    usage: (msg as { usage?: unknown }).usage ?? undefined,
    tokenUsage: msg.tokenUsage ?? undefined,
    isCompactBoundary: msg.isCompactBoundary ?? undefined,
  }
}

// ─── Suppression ────────────────────────────────────────────────────────────────

/**
 * Minimal failure suppression.
 *
 * Unlike the old 5-state machine, this tracks only two things:
 * - why we failed (failure type → when to retry)
 * - whether to block 'auto' compactions at all
 *
 * Failure types:
 *   'auth'   → blocked until onAuthRefresh() is called
 *   'size'   → blocked until next successful compaction (clearOnBudgetChange)
 *   'other'  → blocked until next turn start (clearOnTurnStart)
 *   null     → not suppressed
 */
type FailureType = 'auth' | 'size' | 'other' | null

class Suppression {
  private failure: FailureType = null
  private suppressedUntil = 0 // unix ms, 0 = no time-based block

  isActive(): boolean {
    if (this.failure === null) return false
    if (this.suppressedUntil > 0 && Date.now() > this.suppressedUntil) {
      this.failure = null
      this.suppressedUntil = 0
      return false
    }
    return true
  }

  suppress(type: FailureType): void {
    this.failure = type
    this.suppressedUntil = 0
  }

  clearOnBudgetChange(): void {
    if (this.failure === 'size') {
      this.failure = null
      this.suppressedUntil = 0
    }
  }

  clearOnTurnStart(): void {
    if (this.failure === 'other') {
      this.failure = null
      this.suppressedUntil = 0
    }
  }

  clearOnAuthRefresh(): void {
    if (this.failure === 'auth') {
      this.failure = null
      this.suppressedUntil = 0
    }
  }

  /** Returns the failure type for logging. */
  getFailureType(): FailureType {
    return this.failure
  }
}

// ─── Config & Events ───────────────────────────────────────────────────────────

export interface CompactionManagerConfig {
  maxTokens?: number
  /** Reserved tokens for response. Compacts when totalTokens > maxTokens - reserveTokens. Default 16384. */
  reserveTokens?: number
  systemPromptTokens?: number
  enableReinjection?: boolean
  reinjectionConfig?: Partial<ReinjectorConfig>
  keepRecentTokens?: number
}

export type CompactionManagerEvent =
  | { type: 'compaction_start'; strategy: string }
  | { type: 'compaction_complete'; result: CompactionResult }
  | { type: 'compaction_error'; error: string; suppressed?: boolean }
  | { type: 'reinject_complete'; files: number; skills: number }

export interface EnhancedCompactionResult extends CompactionResult {
  reinjection?: {
    filesReinjected: number
    skillsReinjected: number
    toolsRestored: number
    totalTokensAdded: number
  }
  overThresholdAfterCompact?: boolean
}

// ─── Manager ───────────────────────────────────────────────────────────────────

export class CompactionManager {
  private budget: TokenBudgetManager
  private lastCompactionAt?: number
  private events = new Set<(e: CompactionManagerEvent) => void>()
  private summarizer?: (text: string, prompt: string) => Promise<string>
  private reinjector?: PostCompactReinjector
  private memoryFlush?: (summary: string) => Promise<void>
  private suppression = new Suppression()

  /** Last prompt volume reported by the provider (authoritative anchor). */
  private observedPromptTokens?: number

  constructor(private config: CompactionManagerConfig = {}) {
    this.budget = new TokenBudgetManager({
      maxTokens: config.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
      systemPromptTokens: config.systemPromptTokens ?? 8000,
      reservedTokens: config.reserveTokens ?? 16_384,
    })
    if (config.enableReinjection) {
      this.reinjector = new PostCompactReinjector(config.reinjectionConfig)
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setSummarizer(fn: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = fn
    const strategy = new SessionMemoryCompactStrategy({
      keepRecentTokens: this.config.keepRecentTokens,
    })
    strategy.setSummarizer(fn)
  }

  setMemoryFlushFn(fn: (summary: string) => Promise<void>): void {
    this.memoryFlush = fn
  }

  /**
   * Reserve tokens for the next turn's response. Compacts when:
   *   totalTokens > maxTokens - reserveTokens
   *
   * This is the only threshold function — matches Pi exactly.
   */
  shouldCompact(messages: readonly Message[]): boolean {
    if (this.suppression.isActive()) return false
    const totalTokens = this.contextSize(messages)
    return totalTokens > this.budget.maxTokens - this.budget.reservedTokens
  }

  /** Token count for the context ring (same algorithm, always consistent). */
  getContextTokens(messages: readonly Message[]): number {
    return this.contextSize(messages)
  }

  getStats(messages?: readonly Message[]): CompactionStats {
    const totalTokens = messages ? this.contextSize(messages) : 0
    return {
      totalTokens,
      maxTokens: this.budget.maxTokens,
      messageCount: 0,
      toolCallCount: 0,
      sessionAge: this.lastCompactionAt ? Date.now() - this.lastCompactionAt : 0,
      lastCompactionAt: this.lastCompactionAt,
    }
  }

  getMaxTokens(): number {
    return this.budget.maxTokens
  }

  /**
   * Rewrite the compaction budget to a new context window. Called on
   * runtime model switches (DuyaAgent streamChat drift detection) so a move
   * to a larger-window model (e.g. 200k → 1M) raises the threshold instead
   * of staying pinned at the original window.
   *
   * Non-positive values are ignored (guards the constructor default path).
   * systemPromptTokens / reservedTokens from the original config are
   * preserved across the rebuild. A real budget change also clears 'size'
   * suppression — a window change is exactly the budget change it waits for.
   */
  updateMaxTokens(maxTokens: number): void {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
    if (maxTokens === this.budget.maxTokens) return;
    this.budget = new TokenBudgetManager({
      maxTokens,
      systemPromptTokens: this.config.systemPromptTokens ?? 8000,
      reservedTokens: this.config.reserveTokens ?? 16_384,
    });
    this.suppression.clearOnBudgetChange();
  }

  /**
   * Called by DuyaAgent after each result event with the actual prompt volume
   * the provider reported. This anchors the next shouldCompact() call to real
   * data instead of a char heuristic.
   */
  setObservedPromptTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.observedPromptTokens = Math.floor(tokens)
    }
  }

  clearObservedPromptTokens(): void {
    this.observedPromptTokens = undefined
  }

  /** Called when a compaction succeeds — clears 'size' suppression. */
  onCompactionSuccess(): void {
    this.suppression.clearOnBudgetChange()
    this.lastCompactionAt = Date.now()
  }

  /** Called at the start of each turn — clears 'other' suppression. */
  onTurnStart(): void {
    this.suppression.clearOnTurnStart()
  }

  /** Called when auth/token is refreshed — clears 'auth' suppression. */
  onAuthRefresh(): void {
    this.suppression.clearOnAuthRefresh()
  }

  cacheSkillContext(skills: SkillContextEntry[]): void {
    this.reinjector?.cacheSkillContext(skills)
  }

  cacheToolState(toolName: string, status: 'active' | 'completed' | 'error', output?: string): void {
    this.reinjector?.cacheToolState(toolName, { status, lastOutput: output })
  }

  addEventHandler(handler: (e: CompactionManagerEvent) => void): void {
    this.events.add(handler)
  }

  removeEventHandler(handler: (e: CompactionManagerEvent) => void): void {
    this.events.delete(handler)
  }

  isSuppressed(): boolean {
    return this.suppression.isActive()
  }

  getSuppressionType(): string {
    return this.suppression.getFailureType() ?? 'none'
  }

  getReinjector(): PostCompactReinjector | undefined {
    return this.reinjector
  }

  clearCache(): void {
    this.reinjector?.clearCache()
    this.lastCompactionAt = undefined
    this.observedPromptTokens = undefined
  }

  // ─── Compact ────────────────────────────────────────────────────────────────

  async compact(
    messages: Message[],
    options?: CompactOptions & {
      workingDirectory?: string
      recentChanges?: SessionMemoryFileChangeRecord[]
      customReinjectContext?: string
    },
  ): Promise<EnhancedCompactionResult> {
    const trigger = options?.trigger ?? 'manual'
    const strategy = new SessionMemoryCompactStrategy({
      keepRecentTokens: this.config.keepRecentTokens,
    })
    if (this.summarizer) strategy.setSummarizer(this.summarizer)

    this.emit({ type: 'compaction_start', strategy: strategy.name })

    if (!Array.isArray(messages) || messages.length === 0) {
      const err = new Error('Compaction failed: conversation is empty')
      this.emitError(err, trigger, false)
      throw err
    }

    try {
      if (this.reinjector) {
        this.reinjector.cacheFileState(messages)
      }

      const stats = this.getStats(messages)
      const baseResult = await strategy.compact(messages, stats, options)

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
          this.emit({ type: 'reinject_complete', files: reinjectionInfo.filesReinjected, skills: reinjectionInfo.skillsReinjected })
        } catch (reinjectError) {
          logger.warn('Post-compact reinjection failed', {
            error: reinjectError instanceof Error ? reinjectError.message : String(reinjectError),
          })
        }
      }

      // Validate: strip orphan tool_results
      {
        const violations = validateCompactedHistory(finalMessages)
        if (violations.length > 0) {
          logger.warn('Compaction: orphan tool_results stripped', { count: violations.length })
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
                  !(
                    b.type === 'tool_result' &&
                    typeof (b as { tool_use_id?: string }).tool_use_id === 'string' &&
                    !toolUseIds.has((b as { tool_use_id: string }).tool_use_id)
                  ),
              )
              return cleaned.length === msg.content.length ? msg : { ...msg, content: cleaned }
            })
            .filter((msg) => !(Array.isArray(msg.content) && msg.content.length === 0))
        }
      }

      // Panic fall-back: if still over budget, aggressive trim. Budget here
      // is the same one shouldCompact uses (maxTokens − reserveTokens), so
      // post-compact projection compared against the same threshold remains
      // consistent — over-budget after compression triggers further trim.
      const available = this.budget.maxTokens - this.budget.reservedTokens
      if (this.contextSize(finalMessages) > available) {
        finalMessages = fitCompactedToBudget(finalMessages, available)
      }

      // Memory flush (best-effort)
      if (baseResult.summaryText && this.memoryFlush) {
        this.memoryFlush(baseResult.summaryText).catch(() => {})
      }

      const finalTokens = this.contextSize(finalMessages)
      const overThresholdAfterCompact = finalTokens > this.budget.maxTokens - this.budget.reservedTokens

      this.onCompactionSuccess()
      this.clearObservedPromptTokens()

      const result: EnhancedCompactionResult = {
        ...baseResult,
        messages: finalMessages,
        tokensRetained: this.contextSize(finalMessages),
        reinjection: reinjectionInfo,
        overThresholdAfterCompact,
      }

      this.emit({ type: 'compaction_complete', result })
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const isSizeError =
        err.message.includes('context_length_exceeded') ||
        err.message.includes('max_tokens') ||
        err.message.includes('token limit')
      const isAuthError =
        err.message.includes('auth') ||
        err.message.includes('401') ||
        err.message.includes('unauthorized')

      if (trigger === 'auto') {
        this.suppression.suppress(isSizeError ? 'size' : isAuthError ? 'auth' : 'other')
        this.emitError(err, trigger, true)
      } else {
        this.emitError(err, trigger, false)
      }
      throw error
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private contextSize(messages: readonly Message[]): number {
    if (this.observedPromptTokens !== undefined) return this.observedPromptTokens
    const est = computeContextEstimate(
      messages.map(toContextEstimateMessage),
      { systemPrefixTokens: this.budget.systemPromptTokens + this.budget.reservedTokens },
    )
    return est.usedTokens ?? 0
  }

  private emit(event: CompactionManagerEvent): void {
    for (const h of this.events) {
      try { h(event) } catch { /* ignore */ }
    }
  }

  private emitError(err: Error, trigger: string, suppressed: boolean): void {
    this.emit({ type: 'compaction_error', error: err.message, suppressed })
  }
}

export function createCompactionManager(config?: CompactionManagerConfig): CompactionManager {
  return new CompactionManager(config)
}
