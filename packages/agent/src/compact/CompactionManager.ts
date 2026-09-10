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
import { BackgroundPrefire } from './BackgroundPrefire.js'
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

  /**
   * Plan 517 P2.2: idempotent suppress — apply `type` only when no
   * suppression is currently active. Mirrors the 5-state
   * `CompactSuppression.trySuppress` semantics but for the legacy
   * 3-state machine. Returns true when the suppression was applied,
   * false when an existing suppression kept precedence (so callers
   * can avoid double-firing).
   */
  trySuppress(type: FailureType): boolean {
    if (this.failure !== null) return false
    this.failure = type
    this.suppressedUntil = 0
    return true
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
  /**
   * Background prefire (Plan 495 G1): fraction of the compaction threshold
   * at which the passive pass1 summarization starts. Default 0.75; `0`
   * disables. Results are consumed as the next compaction's
   * `previousSummary` seed when the message prefix is still valid.
   */
  prefireStartFraction?: number
}

export type CompactionManagerEvent =
  | { type: 'compaction_start'; strategy: string }
  | { type: 'compaction_complete'; result: CompactionResult }
  | { type: 'compaction_error'; error: string; suppressed?: boolean }
  | { type: 'reinject_complete'; files: number; skills: number }
  /**
   * Plan 517 P3: lifecycle step boundaries emitted during compact() so the
   * renderer can show where in the pipeline the worker currently is. Each
   * step has a stable string key + the inputs that drive the step's
   * UI text (e.g. messageCount for 'summarizing' surfaces "compressed N
   * messages of the conversation"). Steps are intentionally coarse —
   * summarize is the slowest step by far but the legacy summarizer does
   * not stream progress; a 'started' emit + a 'completed' implicit via
   * the next 'started' is the most honest signal we have today.
   */
  | {
      type: 'compaction_step'
      step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming'
      phase: 'started' | 'finished'
      messageCount?: number
      tokensBefore?: number
      tokensEstimated?: number
      filesCached?: number
    }
  /**
   * Plan 517 P2.2: emitted after a successful compaction when the
   * post-compaction projection is still above the budget (e.g. system
   * prompt + reinject overshoots). Consumers (typically DuyaAgent) react
   * by suppress('size') so the next shouldCompact() call returns false
   * until a future compaction actually reduces the context below the
   * threshold — breaks the compaction loop.
   */
  | { type: 'compaction_over_threshold'; tokensRetained: number; available: number }

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
  /** Background pass1 summarization state (Plan 495 G1). */
  private prefire: BackgroundPrefire

  /** Last prompt volume reported by the provider (authoritative anchor). */
  private observedPromptTokens?: number

  constructor(private config: CompactionManagerConfig = {}) {
    this.budget = new TokenBudgetManager({
      maxTokens: config.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
      systemPromptTokens: config.systemPromptTokens ?? 8000,
      reservedTokens: config.reserveTokens ?? 16_384,
    })
    this.prefire = new BackgroundPrefire({ prefireStartFraction: config.prefireStartFraction })
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

  /**
   * Plan 517 P2.3: read the most recent provider-anchored prompt volume.
   * Returns undefined when no anchor is set (post-compaction window or
   * never-streamed agent). Used by the turn-based + token-based cooldown
   * gate in DuyaAgent to suppress repeated auto-compaction.
   */
  getObservedPromptTokens(): number | undefined {
    return this.observedPromptTokens
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

  /**
   * Kick the background pass1 summarization when usage approaches the
   * compaction threshold (Plan 495 G1). Called by the agent loop at the
   * proactive checkpoint with the current projected messages. Best-effort:
   * never throws and never blocks the turn.
   */
  maybeStartPrefire(messages: readonly Message[]): void {
    if (!this.summarizer) return
    try {
      const usedTokens = this.contextSize(messages)
      const threshold = this.budget.maxTokens - this.budget.reservedTokens
      this.prefire.maybeStart(usedTokens, threshold, messages, (msgs) =>
        this.runPrefirePass([...msgs]),
      )
    } catch {
      // Prefire is opportunistic — any projection failure just skips it.
    }
  }

  /** True when a completed pass1 result is available and prefix-valid. */
  hasFreshPrefire(messages: readonly Message[]): boolean {
    return this.prefire.hasFresh(messages)
  }

  /**
   * Consume the fresh pass1 text as the active compaction's iterative-update
   * seed (grok pass2 semantics). Clears the prefire state either way.
   */
  async takePrefireSummary(messages: readonly Message[]): Promise<string | undefined> {
    try {
      return await this.prefire.takeFresh(messages)
    } catch {
      this.prefire.clear()
      return undefined
    }
  }

  private async runPrefirePass(messages: Message[]): Promise<string> {
    const strategy = new SessionMemoryCompactStrategy({
      keepRecentTokens: this.config.keepRecentTokens,
    })
    strategy.setSummarizer(this.summarizer!)
    return await strategy.summarizeConversation(messages)
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
    this.prefire.clear()
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

    // Plan 517 P3: step boundary emits. summarize + cut live inside the
    // strategy.compact() call so we emit 'started' before and the next
    // step's 'started' implicitly marks the previous as finished. The
    // current summarizer does not stream progress (single-shot callback),
    // so the renderer shows a spinner with the messageCount hint rather
    // than a live progress bar.
    const emitStep = (
      step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming',
      phase: 'started' | 'finished',
      extra: {
        messageCount?: number
        tokensBefore?: number
        tokensEstimated?: number
        filesCached?: number
      } = {},
    ): void => {
      this.emit({ type: 'compaction_step', step, phase, ...extra })
    }
    const stats = this.getStats(messages)
    emitStep('projecting', 'started', {
      messageCount: messages.length,
      tokensBefore: this.contextSize(messages),
    })

    if (!Array.isArray(messages) || messages.length === 0) {
      const err = new Error('Compaction failed: conversation is empty')
      this.emitError(err, trigger, false)
      throw err
    }

    try {
      if (this.reinjector) {
        this.reinjector.cacheFileState(messages)
      }

      emitStep('summarizing', 'started', {
        messageCount: messages.length,
        tokensBefore: this.contextSize(messages),
      })
      const baseResult = await strategy.compact(messages, stats, options)
      emitStep('summarizing', 'finished', {
        messageCount: baseResult.messages.length,
        tokensBefore: this.contextSize(messages),
        tokensEstimated: this.contextSize(baseResult.messages),
      })

      let finalMessages = baseResult.messages
      let reinjectionInfo: EnhancedCompactionResult['reinjection'] | undefined

      const cachedFiles = this.reinjector?.getCacheStats().filesCached ?? 0
      if (cachedFiles > 0) {
        emitStep('reinjecting', 'started', {
          messageCount: finalMessages.length,
          filesCached: cachedFiles,
        })
        try {
          const reinjectResult = await this.reinjector!.reinject(baseResult.messages, {
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
          emitStep('reinjecting', 'finished', {
            messageCount: finalMessages.length,
            tokensEstimated: this.contextSize(finalMessages),
          })
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
      const tokensBeforeTrim = this.contextSize(finalMessages)
      if (tokensBeforeTrim > available) {
        emitStep('trimming', 'started', {
          messageCount: finalMessages.length,
          tokensBefore: tokensBeforeTrim,
          tokensEstimated: available,
        })
        finalMessages = fitCompactedToBudget(finalMessages, available)
        emitStep('trimming', 'finished', {
          messageCount: finalMessages.length,
          tokensEstimated: this.contextSize(finalMessages),
        })
      }

      // Memory flush (best-effort)
      if (baseResult.summaryText && this.memoryFlush) {
        this.memoryFlush(baseResult.summaryText).catch(() => {})
      }

      const finalTokens = this.contextSize(finalMessages)
      const overThresholdAfterCompact = finalTokens > this.budget.maxTokens - this.budget.reservedTokens

      // Plan 517 P2.2: activate the dead-code `overThresholdAfterCompact`
      // flag as an active loop brake. When compaction cannot shrink the
      // context below the threshold (system prompt + reinject overshoot),
      // suppress 'size' so subsequent shouldCompact() returns false until
      // a future successful compaction drives `finalTokens` down. This
      // breaks the loop where compaction runs every other turn because
      // the post-compaction context keeps re-crossing the threshold.
      if (overThresholdAfterCompact) {
        this.suppression.trySuppress('size')
        this.emit({
          type: 'compaction_over_threshold',
          tokensRetained: finalTokens,
          available: this.budget.maxTokens - this.budget.reservedTokens,
        })
      }

      this.onCompactionSuccess()
      this.clearObservedPromptTokens()
      // The rewrite invalidates any prefire fingerprint — drop it so the
      // next cycle starts clean (Plan 495 G1 lifecycle).
      this.prefire.clear()

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
