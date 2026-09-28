/**
 * Compaction Manager — Pi/grok-aligned, anchor-based, flat.
 *
 * Design:
 * - Token counting: always via computeContextEstimate() (same as renderer ring).
 *   Plan 577 §2: the projection is shrink-aware — the timeline scan
 *   (anchor + trailing) is the base measurement, a schema delta is added on
 *   top (tool growth the next request will carry), and live provider
 *   observations fill the windows the scan cannot see (post-compaction "?",
 *   no-anchor-yet). The old "observed round-max overrides everything"
 *   short-circuit is gone: it pinned the measurement at the turn peak even
 *   after a prune shrank the projection.
 * - Threshold: totalTokens > triggerHighWatermark  (max − reserve, Pi style).
 *   Plan 577 §4: the budget is a four-line model — trigger (proactive),
 *   rearm (suppression state machine), target (optimization goal only) and
 *   hardLimit (mid-loop overflow). Suppression lifts on the rearm line, not
 *   "on success".
 * - Suppression: lightweight — remember the last failure type and when to retry.
 *   No 5-state machine. Failures: auth (time-windowed, plan 552), size (cleared
 *   when the projection re-arms below the rearm low-watermark or the budget
 *   changes), other (cleared on next turn). Failure classification is
 *   single-sourced in compactErrors.classifySuppressReason.
 * - No prefire. No iterative summary. No suppression cooldown constants.
 * - Flat delegation: one class, one shouldCompact() call.
 * - Accounting (plan 577 §2.1/§3): the Observation / Accounting-State layers
 *   and the epoch counter live in the ContextLedger — the single observation
 *   entry point. This manager delegates to it; accounting semantics (latest
 *   falls only across a noted shrink, peak is a per-epoch high-water mark)
 *   are unchanged from Phase 1.
 */

import type { Message, MessageContent } from '../types.js'
import type { CompactionResult, CompactionStats, CompactionStrategy, CompactOptions } from './types.js'
import { DEFAULT_CONTEXT_WINDOW } from './types.js'
import { TokenBudgetManager } from './tokenBudget.js'
import {
  applyLiveAnchorCorrection,
  computeContextEstimate,
  estimateContextMessageTokens,
  normalizePromptTokens,
  type ContextAccountingState,
  type ContextEstimateMessage,
  type ContextSnapshot,
} from '@duya/ai'
import { ContextLedger } from '../context/ContextLedger.js'
import { logger } from '../utils/logger.js'
import { SessionMemoryCompactStrategy } from './strategies/index.js'
import { BackgroundPrefire } from './BackgroundPrefire.js'
import { PostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'
import type { FileChangeRecord as SessionMemoryFileChangeRecord } from './strategies/SessionMemoryCompactStrategy.js'
import { fitCompactedToBudget, validateCompactedHistory } from './historySanitize.js'
import { classifySuppressReason, suppressReasonMessage, type SuppressReason } from './compactErrors.js'
import { countImagePartsInMessages, IMAGE_COMPACTION_TRIGGER_COUNT } from './imageParts.js'

/**
 * Plan 552: result of {@link CompactionManager.probeCompaction} — the single
 * measurement all trigger sites consume. Lines are owned by the manager's
 * budget; gating (suppression / cooldown) belongs to the callers.
 */
export interface CompactionProbe {
  /** Estimated / provider-anchored context size in tokens. */
  tokens: number
  /** Image blocks present in the projected context. */
  imageCount: number
  /** `imageCount >= IMAGE_COMPACTION_TRIGGER_COUNT` (grok image trigger). */
  imageTriggered: boolean
  /** `tokens > triggerLine` — the pre-turn proactive line (max − reserve). */
  overTriggerLine: boolean
  /** `tokens > hardLimit` — the mid-loop overflow line (full window). */
  overHardLimit: boolean
  /** Plan 577 §2: high-water mark of observed inputs since the last epoch
   *  reset. Overflow diagnostics / tokenTrace consume this — the projection
   *  may sit far below what this session already saw (post-prune). */
  peakInputTokens?: number
}

/**
 * How long an 'auth' failure blocks auto-compaction (plan 552). The old
 * design waited for onAuthRefresh(), which had zero production callers —
 * one 401 during an auto compaction permanently disabled proactive
 * compaction for the rest of the session. A bounded window keeps the
 * "don't hammer a failing endpoint" property while guaranteeing recovery.
 */
const AUTH_SUPPRESS_WINDOW_MS = 5 * 60_000

// ─── Adapters ─────────────────────────────────────────────────────────────────

function toContextEstimateMessage(msg: Message): ContextEstimateMessage {
  return {
    role: msg.role,
    content: msg.content as string | unknown[],
    usage: (msg as { usage?: unknown }).usage ?? undefined,
    tokenUsage: msg.tokenUsage ?? undefined,
    model: msg.model ?? undefined,
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
 *   'auth'   → blocked for AUTH_SUPPRESS_WINDOW_MS (plan 552: self-healing —
 *              the previous onAuthRefresh() clear trigger had no callers)
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
    this.suppressedUntil = type === 'auth' ? Date.now() + AUTH_SUPPRESS_WINDOW_MS : 0
  }

  /**
   * Plan 517 P2.2: idempotent suppress — apply `type` only when no
   * suppression is currently active. Returns true when the suppression was
   * applied, false when an existing suppression kept precedence (so callers
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
  /**
   * Plan 577 §4: the rearm low-watermark (suppression state-machine line).
   * Default: 0.75 × maxTokens. Must stay ≤ the trigger line.
   */
  rearmLowWatermark?: number
  /**
   * Plan 577 §4: the compaction optimization goal. Never gates the state
   * machine. Default: 0.6 × maxTokens.
   */
  compactionTarget?: number
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
  | {
      type: 'compaction_error'
      error: string
      suppressed?: boolean
      /** Plan 552: classified failure reason (classifySuppressReason). */
      reason?: SuppressReason
      /** Plan 552: user-facing one-liner for the reason. */
      userMessage?: string
    }
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
  /**
   * Plan 523 P6: one event per summarization attempt inside the retry ladder,
   * so the renderer / logs can see *why* a retry or failure happened (degenerate
   * output, empty response, output-length error, …) instead of only the coarse
   * 'summarizing' step boundary.
   */
  | {
      type: 'compaction_summary_outcome'
      attempt: number
      outcome: 'success' | 'degenerate' | 'empty' | 'error'
      errorKind?: string
      chars: number
    }

export interface EnhancedCompactionResult extends CompactionResult {
  reinjection?: {
    filesReinjected: number
    skillsReinjected: number
    toolsRestored: number
    totalTokensAdded: number
    /**
     * Plan 552: the restored context sections. Producers write into the
     * compaction entry's `reinjectedSystemMessages` — the single channel —
     * instead of embedding system-role messages in {@link CompactionResult.messages}.
     */
    systemMessages?: (string | readonly MessageContent[])[]
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

  /**
   * Plan 577 §3: the Observation / Accounting-State layer and the epoch
   * counter live here — the single observation entry point. This manager
   * is the ledger's host and delegates all accounting reads to it.
   */
  private readonly ledger = new ContextLedger()

  constructor(private config: CompactionManagerConfig = {}) {
    this.budget = new TokenBudgetManager({
      maxTokens: config.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
      systemPromptTokens: config.systemPromptTokens ?? 8000,
      reservedTokens: config.reserveTokens ?? 16_384,
      rearmLowWatermark: config.rearmLowWatermark,
      compactionTarget: config.compactionTarget,
    })
    this.prefire = new BackgroundPrefire({ prefireStartFraction: config.prefireStartFraction })
    if (config.enableReinjection) {
      this.reinjector = new PostCompactReinjector(config.reinjectionConfig)
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setSummarizer(fn: (text: string, prompt: string) => Promise<string>): void {
    // Plan 552: strategies instantiate per compact()/prefire call and take the
    // summarizer there — no eager allocation at wiring time.
    this.summarizer = fn
  }

  setMemoryFlushFn(fn: (summary: string) => Promise<void>): void {
    this.memoryFlush = fn
  }

  /**
   * Reserve tokens for the next turn's response. Compacts when:
   *   totalTokens > triggerHighWatermark (maxTokens - reserveTokens)
   *
   * Plan 577 §4: BEFORE the suppression gate, the rearm hysteresis is
   * evaluated — when a 'size' suppression is active and the projection has
   * fallen below the rearm low-watermark, the system re-arms.
   */
  shouldCompact(messages: readonly Message[]): boolean {
    const totalTokens = this.contextSize(messages)
    this.maybeRearm(totalTokens)
    if (this.suppression.isActive()) return false
    return totalTokens > this.budget.triggerHighWatermark
  }

  /**
   * Plan 552: single measurement point for every trigger site. Both decision
   * lines are derived from this manager's budget, so the pre-turn proactive
   * check, the mid-loop overflow check and the renderer ring can no longer
   * disagree about where the lines are. Pure measurement — suppression /
   * cooldown gates stay with the callers.
   */
  probeCompaction(messages: readonly Message[]): CompactionProbe {
    const tokens = this.contextSize(messages)
    const imageCount = countImagePartsInMessages(messages)
    return {
      tokens,
      imageCount,
      imageTriggered: imageCount >= IMAGE_COMPACTION_TRIGGER_COUNT,
      overTriggerLine: tokens > this.getTriggerLine(),
      overHardLimit: tokens > this.getHardLimit(),
      peakInputTokens: this.getPeakInputTokens(),
    }
  }

  /** Soft line: proactive compaction fires above it (max − reserve).
   *  Plan 577 §4: derived from the budget's triggerHighWatermark. */
  getTriggerLine(): number {
    return this.budget.triggerHighWatermark
  }

  /** Hard line: the full window — mid-loop overflow fires at it. */
  getHardLimit(): number {
    return this.budget.hardLimit
  }

  /** Plan 577 §4: suppression state-machine line (default 0.75 × window). */
  getRearmLowWatermark(): number {
    return this.budget.rearmLowWatermark
  }

  /** Plan 577 §4: compaction optimization goal (default 0.6 × window) —
   *  never a state-machine threshold. */
  getCompactionTarget(): number {
    return this.budget.compactionTarget
  }

  /**
   * Plan 577 §4: the rearm half of the double-watermark hysteresis.
   *
   * A 'size' suppression is lifted when the CURRENT projection falls below
   * the rearm low-watermark — regardless of whether any compaction reached
   * the target. Replaces the old "successful compaction clears suppression"
   * rule, which kept the system suppressed even when the context had
   * legitimately shrunk (prune) and suppressed it forever when a
   * summarizer plateaued above the trigger line.
   *
   * Safe to call on every measurement: idempotent, only ever touches the
   * 'size' scope, and logs the transition once.
   */
  maybeRearm(currentTokens: number): boolean {
    if (this.suppression.getFailureType() !== 'size') return false
    if (!this.suppression.isActive()) return false
    if (currentTokens > this.budget.rearmLowWatermark) return false
    this.suppression.clearOnBudgetChange()
    logger.info(
      `[CompactionManager] re-arm: projection ${currentTokens} ≤ rearm low-watermark ` +
        `${this.budget.rearmLowWatermark} — 'size' suppression lifted`,
    )
    return true
  }

  /** Token count for the context ring (same algorithm, always consistent). */
  getContextTokens(messages: readonly Message[]): number {
    return this.contextSize(messages)
  }

  /**
   * Build the one context snapshot shared by budget decisions and the live
   * worker frame. The ledger contributes provider facts and lineage; this
   * manager applies the persisted-timeline and schema deltas once.
   */
  getContextSnapshot(messages: readonly Message[]): ContextSnapshot {
    const estimateMessages = messages.map(toContextEstimateMessage)
    const estimate = computeContextEstimate(estimateMessages, {
      systemPrefixTokens: this.budget.systemPromptTokens + this.budget.reservedTokens,
    })
    const snapshot = this.ledger.getSnapshot()
    const anchorMessage =
      estimate.anchorIndex === null ? undefined : estimateMessages[estimate.anchorIndex]
    const scanAnchorInputTokens = normalizePromptTokens(
      anchorMessage?.usage ?? anchorMessage?.tokenUsage,
    ).prompt
    const observation = snapshot.observation
    const projection = applyLiveAnchorCorrection({
      scanUsedTokens: estimate.usedTokens,
      scanAnchorInputTokens,
      scanAnchored: estimate.anchored,
      timelineIncludesLiveObservation:
        observation !== null && scanAnchorInputTokens === observation.inputTokens,
      liveLatestInputTokens:
        snapshot.accounting.latestInputTokens ?? observation?.inputTokens ?? 0,
      schemaDelta: this.ledger.currentSchemaDelta(),
      shrinkArmed: snapshot.lastObservationFollowedShrink,
    })

    snapshot.accounting = {
      ...snapshot.accounting,
      projectedNextInputTokens: projection.usedTokens,
    }
    snapshot.estimateSource = projection.estimateSource
    snapshot.confidence =
      projection.estimateSource === 'provider'
        ? 'authoritative'
        : projection.estimateSource === 'anchor_projection'
          ? 'derived'
          : 'heuristic'
    return snapshot
  }

  getStats(messages?: readonly Message[]): CompactionStats {
    const totalTokens = messages ? this.contextSize(messages) : 0
    return {
      totalTokens,
      maxTokens: this.budget.maxTokens,
      sessionAge: this.lastCompactionAt ? Date.now() - this.lastCompactionAt : 0,
      lastCompactionAt: this.lastCompactionAt,
    }
  }

  getMaxTokens(): number {
    return this.budget.maxTokens
  }

  /** Plan 577 §3: raw ledger facts. Live ring and compaction consumers should
   *  use getContextSnapshot() so they share the timeline-enriched projection. */
  getContextLedger(): ContextLedger {
    return this.ledger
  }

  /**
   * Rewrite the compaction budget to a new context window. Called on
   * runtime model switches (DuyaAgent streamChat drift detection) so a move
   * to a larger-window model (e.g. 200k → 1M) raises the threshold instead
   * of staying pinned at the original window.
   *
   * Non-positive values are ignored (guards the constructor default path).
   * systemPromptTokens / reservedTokens / rearm-target overrides from the
   * original config are preserved across the rebuild (explicit overrides
   * stay absolute; fraction-derived ones re-derive from the new window).
   * A real budget change also clears 'size' suppression — a window change
   * is exactly the budget change it waits for.
   */
  updateMaxTokens(maxTokens: number): void {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
    if (maxTokens === this.budget.maxTokens) return;
    this.budget = new TokenBudgetManager({
      maxTokens,
      systemPromptTokens: this.config.systemPromptTokens ?? 8000,
      reservedTokens: this.config.reserveTokens ?? 16_384,
      rearmLowWatermark: this.config.rearmLowWatermark,
      compactionTarget: this.config.compactionTarget,
    });
    this.suppression.clearOnBudgetChange();
  }

  /**
   * Plan 577 §2.1 → §3: Observation-layer entry point (delegates to the
   * ContextLedger). Called by DuyaAgent after each result event with the
   * call's cache-aware normalized input (the prompt the provider actually
   * saw) and its output.
   *
   * Accounting updates (ledger-owned semantics, unchanged from Phase 1):
   * - `latest` replaces unconditionally when a shrink was noted since the
   *   last observation (prune legitimately lowered the context); otherwise a
   *   decrease is treated as a gateway under-report and the previous value
   *   is kept (the round-max defense the old single-anchor fed on).
   * - `peak` is a pure high-water mark — it never falls within an epoch.
   * - The schema snapshot is re-taken so post-observation tool growth shows
   *   up as a schemaDelta instead of waiting for the next provider report.
   */
  setObservedUsage(inputTokens: number, outputTokens: number): void {
    this.ledger.recordObservation({ inputTokens, outputTokens })
  }

  /**
   * Plan 577 §3: epoch-tagged variant. `epoch` is the generation the
   * observer captured when the request was built — an older value means the
   * observation is stale (a compaction rewrote the timeline mid-flight) and
   * the ledger DROPS it instead of letting it drag the ring backwards.
   */
  setObservedUsageForEpoch(
    inputTokens: number,
    outputTokens: number,
    epoch: number,
  ): boolean {
    return this.ledger.recordObservation({ inputTokens, outputTokens, epoch })
  }

  /**
   * Compat shim (plan 577 transition): the historical single-number feed.
   * The old value was a round-max prompt+output volume; callers that have
   * not migrated to {@link setObservedUsage} land it in the Observation
   * input slot with zero output so the accounting state still advances.
   */
  setObservedPromptTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.setObservedUsage(tokens, 0)
    }
  }

  /**
   * Plan 517 P2.3 → plan 577: read the most recent provider-anchored input
   * volume (Observation layer). Returns undefined when no anchor is set
   * (post-compaction window or never-streamed agent). Consumed by the
   * turn-based + token-based cooldown gate in DuyaAgent; units changed from
   * the old prompt+output volume to input-only — both sides of the growth
   * subtraction use the same units, so the gate semantics are unchanged.
   */
  getObservedPromptTokens(): number | undefined {
    const observation = this.ledger.getObservation()
    return observation ? observation.inputTokens : undefined
  }

  /** Accounting State: latest observed input (may fall across a shrink). */
  getLatestInputTokens(): number | undefined {
    return this.ledger.getLatestInputTokens()
  }

  /** Accounting State: high-water mark since the last epoch reset. */
  getPeakInputTokens(): number | undefined {
    return this.ledger.getPeakInputTokens()
  }

  /**
   * Plan 577 §2: a projection-level shrink was detected by the caller
   * (compressProjectedToolMessages returned a different reference — tool
   * results pruned / offloaded). Arms the next observation to replace
   * `latest` even when smaller, and marks its provenance for the ring-side
   * downward anchor correction. (Delegates to the ledger.)
   */
  noteProjectionShrink(): void {
    this.ledger.noteProjectionShrink()
  }

  /** True when the current latest observation is the first one after a noted
   *  shrink — the ring may correct its anchor downward from it. */
  wasLastObservationPostShrink(): boolean {
    return this.ledger.wasLastObservationPostShrink()
  }

  /**
   * Plan 577 §2: current system+tools estimate (DuyaAgent re-estimates per
   * request build). The delta against the snapshot taken at the last
   * observation is the projection's schemaDelta — an MCP/skill load is felt
   * by the next request without waiting for the provider to report it.
   */
  setSchemaEstimateTokens(tokens: number): void {
    this.ledger.noteSchemaEstimate(tokens)
  }

  /** Plan 577 §3: full accounting-state snapshot from the ledger. */
  getAccountingState(): ContextAccountingState {
    return this.ledger.getAccountingState()
  }

  /** Current ContextLedger epoch (plan 577 §3 generation counter). */
  getContextEpoch(): number {
    return this.ledger.getEpoch()
  }

  /**
   * Epoch reset (plan 577 §3: `beginEpoch('clear')`). Span-style clears
   * (rewind, hard reset) go through here; compaction success uses the
   * explicit 'compaction' reason below. Kept as a compat API — DuyaAgent
   * and tests call this name.
   */
  clearObservedPromptTokens(): void {
    this.ledger.beginEpoch('clear')
  }

  /**
   * Called when a compaction succeeds — records the timestamp. Plan 577 §4:
   * it no longer clears 'size' suppression ("success ⇒ re-arm" is gone);
   * the rearm low-watermark owns that transition now (see maybeRearm and
   * the post-compact hysteresis in compact()).
   */
  onCompactionSuccess(): void {
    this.lastCompactionAt = Date.now()
  }

  /** Called at the start of each turn — clears 'other' suppression. */
  onTurnStart(): void {
    this.suppression.clearOnTurnStart()
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
    this.clearObservedPromptTokens()
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
      // Plan 523 P6: feed each summary-attempt outcome back as an event
      // without mutating the caller-owned options object.
      const outcomeOptions: CompactOptions = options
        ? { ...options, onSummaryAttempt: (r) => this.emit({ type: 'compaction_summary_outcome', ...r }) }
        : { onSummaryAttempt: (r) => this.emit({ type: 'compaction_summary_outcome', ...r }) }
      const baseResult = await strategy.compact(messages, stats, outcomeOptions)
      emitStep('summarizing', 'finished', {
        messageCount: baseResult.messages.length,
        tokensBefore: this.contextSize(messages),
        tokensEstimated: this.contextSize(baseResult.messages),
      })

      let finalMessages = baseResult.messages
      let reinjectionInfo: EnhancedCompactionResult['reinjection'] | undefined
      // Plan 552: restored context now travels as result segments, not as
      // embedded system messages — its cost is added back to the threshold
      // accounting so the over-threshold loop brake sees the same total the
      // pre-552 message-embedded layout produced.
      let reinjectedTokens = 0

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
          reinjectedTokens = reinjectResult.totalTokensAdded
          reinjectionInfo = {
            filesReinjected: reinjectResult.filesReinjected.length,
            skillsReinjected: reinjectResult.skillsReinjected.length,
            toolsRestored: reinjectResult.toolsRestored.length,
            totalTokensAdded: reinjectResult.totalTokensAdded,
            systemMessages: reinjectResult.systemSegments,
          }
          emitStep('reinjecting', 'finished', {
            messageCount: finalMessages.length,
            tokensEstimated: this.contextSize(finalMessages) + reinjectedTokens,
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
      const tokensBeforeTrim = this.contextSize(finalMessages) + reinjectedTokens
      if (tokensBeforeTrim > available) {
        emitStep('trimming', 'started', {
          messageCount: finalMessages.length,
          tokensBefore: tokensBeforeTrim,
          tokensEstimated: available,
        })
        finalMessages = fitCompactedToBudget(finalMessages, available)
        emitStep('trimming', 'finished', {
          messageCount: finalMessages.length,
          tokensEstimated: this.contextSize(finalMessages) + reinjectedTokens,
        })
      }

      // Memory flush (best-effort)
      if (baseResult.summaryText && this.memoryFlush) {
        this.memoryFlush(baseResult.summaryText).catch(() => {})
      }

      const finalTokens = this.contextSize(finalMessages) + reinjectedTokens
      // Plan 577 §4: the post-compact state machine reads the REARM line,
      // not just the trigger line.
      //   finalTokens > triggerHighWatermark → still over the proactive
      //     line at all → suppress (the old 517 P2.2 loop brake, unchanged);
      //   trigger ≥ finalTokens > rearmLowWatermark → the compaction did
      //     not push the context back into the safe zone: keep 'size'
      //     suppression so auto-compaction waits until the projection falls
      //     below rearm (another compaction, a prune, or a budget change).
      //     "维持 suppression 等待下一次机会" — never a permanent stall:
      //     emergency / model-switch / manual paths bypass the gate, and
      //     shouldCompact() re-arms the moment the projection drops below
      //     the rearm watermark.
      //   finalTokens ≤ rearmLowWatermark → system re-armed; even when the
      //     compactionTarget (optimization goal) was missed, suppression is
      //     lifted (plan 577 §4 key semantics).
      const overTrigger = finalTokens > this.budget.triggerHighWatermark
      const overRearm = finalTokens > this.budget.rearmLowWatermark
      const overThresholdAfterCompact = overRearm

      // Plan 577 §4: a successful compaction whose projection fell below the
      // rearm low-watermark lifts a pre-existing 'size' suppression right
      // here — the rearm line, not "success", owns the release (band
      // semantics spelled out above). Without this call a compaction that
      // landed under the watermark would leave a stale suppression hanging
      // until the next shouldCompact() measurement happened to re-arm it.
      this.maybeRearm(finalTokens)

      if (overRearm) {
        this.suppression.trySuppress('size')
        this.emit({
          type: 'compaction_over_threshold',
          tokensRetained: finalTokens,
          available: this.budget.triggerHighWatermark,
        })
        if (!overTrigger) {
          logger.info(
            `[CompactionManager] post-compact projection ${finalTokens} is below the trigger line ` +
              `but above the rearm watermark ${this.budget.rearmLowWatermark} — keeping ` +
              `'size' suppression until the context re-arms`,
          )
        }
      }

      this.onCompactionSuccess()
      // Plan 577 §3: compaction rewrites the context lineage — a new epoch
      // begins. Stale observations (a result still in flight from the
      // pre-compact context) are dropped by the ledger from here on.
      this.ledger.beginEpoch('compaction')
      // The rewrite invalidates any prefire fingerprint — drop it so the
      // next cycle starts clean (Plan 495 G1 lifecycle).
      this.prefire.clear()

      const result: EnhancedCompactionResult = {
        ...baseResult,
        messages: finalMessages,
        tokensRetained: finalTokens,
        reinjection: reinjectionInfo,
        overThresholdAfterCompact,
      }

      this.emit({ type: 'compaction_complete', result })
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      // Plan 552: single failure classifier (grok classify_suppress_reason)
      // instead of inline keyword checks — one place to add a new marker.
      const reason = classifySuppressReason(err)
      if (trigger === 'auto' && reason !== null) {
        this.suppression.suppress(suppressReasonToFailureType(reason))
        this.emitError(err, trigger, true, reason)
      } else {
        this.emitError(err, trigger, false, reason ?? undefined)
      }
      throw error
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Plan 577 §2: shrink-aware projection measurement.
   *
   * Budget decisions consume the same ContextSnapshot projection emitted to
   * the ring. The timeline scan adds only content actually persisted; a fresh
   * provider input observation bridges the result→push window without adding
   * its output volume or re-adding messages already present in that request.
   */
  private contextSize(messages: readonly Message[]): number {
    return this.getContextSnapshot(messages).accounting.projectedNextInputTokens
  }

  private emit(event: CompactionManagerEvent): void {
    for (const h of this.events) {
      try { h(event) } catch { /* ignore */ }
    }
  }

  private emitError(err: Error, trigger: string, suppressed: boolean, reason?: SuppressReason): void {
    this.emit({
      type: 'compaction_error',
      error: err.message,
      suppressed,
      ...(reason ? { reason, userMessage: suppressReasonMessage(reason) } : {}),
    })
  }
}

/**
 * Map a classified failure reason onto the live 3-scope suppression machine.
 * `schema` shares `size`'s STICKY scope (cleared on the next budget change);
 * `credit` shares `other`'s TURN scope (quota windows are usually short, and
 * a turn boundary re-evaluates with fresh context anyway).
 */
function suppressReasonToFailureType(reason: SuppressReason): Exclude<FailureType, null> {
  switch (reason) {
    case 'size':
    case 'schema':
      return 'size'
    case 'auth':
      return 'auth'
    case 'credit':
    case 'other':
      return 'other'
  }
}

export function createCompactionManager(config?: CompactionManagerConfig): CompactionManager {
  return new CompactionManager(config)
}
