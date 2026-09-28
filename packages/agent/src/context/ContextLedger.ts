/**
 * ContextLedger (plan 577 Phase 2) — the single observation entry point.
 *
 * Every context-relevant event flows through exactly one instance:
 *
 *   - provider result observations   → recordObservation()
 *   - compaction / clear / restore   → beginEpoch(reason)
 *   - model or window switches       → noteModelSwitch()  (NO rollover —
 *     a budget change is not a context-lineage rebuild)
 *
 * The ledger owns the epoch counter. An observation tagged with an older
 * epoch (a late result from before a compaction rewrote the timeline) is
 * DROPPED — it describes a context that no longer exists, and honouring it
 * would drag the ring back to pre-compaction volumes.
 *
 * The Accounting-State semantics migrate verbatim from the Phase 1
 * CompactionManager implementation (latest falls only across a noted
 * shrink, peak is a per-epoch high-water mark, output never joins the
 * anchor, schema growth is felt by the projection immediately) so the
 * Phase 1 tests keep passing through the CompactionManager delegation.
 */

import {
  projectNextInput,
  emptyContextSnapshot,
  type ContextObservation,
  type ContextAccountingState,
  type ContextSnapshot,
  type ContextWindowSource,
} from '@duya/ai'
import { logger } from '../utils/logger.js'

/** Why an epoch began. Interface is not bound to compaction: 'restore'
 *  (session rewind) and 'fork' (branch) are reserved for their callers. */
export type ContextEpochReason = 'compaction' | 'clear' | 'restore' | 'fork'

export interface ContextObservationInput {
  /** Cache-aware normalized prompt the provider saw (WITHOUT output). */
  inputTokens: number
  /** This call's generation volume — never part of the anchor. */
  outputTokens: number
  /** Request lineage when known (plan 561 model-call-trace rows; null ok). */
  requestId?: string
  turnId?: string
  modelId?: string
  /** Provider report time; defaults to now. */
  observedAt?: number
  /** The epoch the OBSERVER captured when the request was built. A mismatch
   *  with the current epoch means the observation is stale → dropped. */
  epoch?: number
}

export interface ContextWindowInfo {
  contextWindow: number
  windowSource: ContextWindowSource
}

export class ContextLedger {
  private currentEpoch = 0
  private observation: ContextObservation | null = null
  private latestInputTokens?: number
  private peakInputTokens?: number
  private shrinkPending = false
  private lastObservationFollowedShrink = false
  private schemaEstimateTokens?: number
  private schemaEstimateAtObservation?: number
  private windowInfo: ContextWindowInfo = { contextWindow: 0, windowSource: 'default' }
  private currentModelId: string | null = null
  private lastUpdatedAt = Date.now()

  /** Current generation. Increments on every beginEpoch. */
  getEpoch(): number {
    return this.currentEpoch
  }

  /**
   * Begin a new context generation. Clears the Observation layer, the
   * accounting state and the shrink flags; the schema baseline is dropped
   * with them (the next observation re-takes it). Window/model lineage is
   * preserved — the context was rebuilt, the runtime did not change.
   */
  beginEpoch(reason: ContextEpochReason): number {
    this.currentEpoch += 1
    this.observation = null
    this.latestInputTokens = undefined
    this.peakInputTokens = undefined
    this.shrinkPending = false
    this.lastObservationFollowedShrink = false
    this.schemaEstimateAtObservation = undefined
    this.lastUpdatedAt = Date.now()
    logger.debug(`[ContextLedger] beginEpoch(${reason}) → epoch=${this.currentEpoch}`)
    return this.currentEpoch
  }

  /**
   * The single Observation entry point. Returns `false` when the
   * observation was dropped as stale (its epoch predates the current one).
   */
  recordObservation(input: ContextObservationInput): boolean {
    if (!Number.isFinite(input.inputTokens) || input.inputTokens <= 0) return false
    if (input.epoch !== undefined && input.epoch !== this.currentEpoch) {
      logger.debug(
        `[ContextLedger] dropped stale observation (observed epoch=${input.epoch}, ` +
          `current=${this.currentEpoch}) — context lineage was rebuilt mid-flight`,
      )
      return false
    }
    const inputTokens = Math.floor(input.inputTokens)
    const outputTokens =
      Number.isFinite(input.outputTokens) && input.outputTokens > 0
        ? Math.floor(input.outputTokens)
        : 0
    this.observation = {
      inputTokens,
      outputTokens,
      source: 'provider',
      requestId: input.requestId ?? '',
      observedAt: input.observedAt ?? Date.now(),
    }
    if (this.shrinkPending) {
      // A prune/offload legitimately lowered the projection — replace
      // `latest` even downward, and record the provenance for the ring's
      // downward anchor correction.
      this.latestInputTokens = inputTokens
      this.shrinkPending = false
      this.lastObservationFollowedShrink = true
    } else {
      this.latestInputTokens =
        this.latestInputTokens === undefined
          ? inputTokens
          : Math.max(this.latestInputTokens, inputTokens)
      this.lastObservationFollowedShrink = false
    }
    this.peakInputTokens =
      this.peakInputTokens === undefined
        ? inputTokens
        : Math.max(this.peakInputTokens, inputTokens)
    this.schemaEstimateAtObservation = this.schemaEstimateTokens
    this.lastUpdatedAt = this.observation.observedAt
    return true
  }

  /** Latest provider observation, verbatim (null when none in this epoch). */
  getObservation(): ContextObservation | null {
    return this.observation
  }

  /** Accounting State: latest observed input (may fall across a shrink). */
  getLatestInputTokens(): number | undefined {
    return this.latestInputTokens
  }

  /** Accounting State: high-water mark since the last epoch reset. */
  getPeakInputTokens(): number | undefined {
    return this.peakInputTokens
  }

  /**
   * A projection-level shrink was detected by the caller (tool results
   * pruned / offloaded). Arms the NEXT observation to replace `latest`
   * even when smaller.
   */
  noteProjectionShrink(): void {
    this.shrinkPending = true
  }

  /** True when the current latest observation is the first one after a
   *  noted shrink — the ring may correct its anchor downward from it. */
  wasLastObservationPostShrink(): boolean {
    return this.lastObservationFollowedShrink
  }

  /**
   * Current system+tools estimate (re-estimated per request build). The
   * delta against the snapshot taken at the last observation is the
   * projection's schemaDelta.
   */
  noteSchemaEstimate(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) return
    this.schemaEstimateTokens = Math.floor(tokens)
  }

  /** Schema growth since the last observation (≥ 0). */
  currentSchemaDelta(): number {
    if (this.schemaEstimateTokens === undefined) return 0
    const baseline = this.schemaEstimateAtObservation ?? this.schemaEstimateTokens
    return Math.max(0, this.schemaEstimateTokens - baseline)
  }

  /**
   * Model or window switch. This is a BUDGET change, not a context-lineage
   * rebuild — observations and accounting state survive (plan 577 §3:
   * model switch does NOT rollover).
   */
  noteModelSwitch(info: ContextWindowInfo, modelId?: string): void {
    this.windowInfo = { contextWindow: info.contextWindow, windowSource: info.windowSource }
    if (modelId) this.currentModelId = modelId
    this.lastUpdatedAt = Date.now()
  }

  /** Resolve/update the window lineage (called on drift detection too). */
  setWindowInfo(info: ContextWindowInfo): void {
    if (
      this.windowInfo.contextWindow === info.contextWindow &&
      this.windowInfo.windowSource === info.windowSource
    ) {
      return
    }
    this.windowInfo = { ...info }
    this.lastUpdatedAt = Date.now()
  }

  getWindowInfo(): ContextWindowInfo {
    return this.windowInfo
  }

  /** Accounting-state triple (plan 577 §2.1); the manager adds timeline deltas. */
  getAccountingState(): ContextAccountingState {
    const latest = this.latestInputTokens
    if (latest === undefined) {
      return { peakInputTokens: this.peakInputTokens, projectedNextInputTokens: 0 }
    }
    return {
      latestInputTokens: latest,
      peakInputTokens: this.peakInputTokens,
      projectedNextInputTokens: projectNextInput({
        baseObservation: { inputTokens: latest },
        schemaDelta: this.currentSchemaDelta(),
      }),
    }
  }

  /** Ledger facts and lineage; CompactionManager enriches this with timeline projection. */
  getSnapshot(): ContextSnapshot {
    const accounting = this.getAccountingState()
    const snapshot = emptyContextSnapshot(this.lastUpdatedAt)
    snapshot.epoch = this.currentEpoch
    snapshot.observation = this.observation
    snapshot.accounting = accounting
    snapshot.observedAt = this.observation?.observedAt ?? 0
    snapshot.lastUpdatedAt = this.lastUpdatedAt
    snapshot.anchorRequestId = this.observation?.requestId || null
    snapshot.anchorTurnId = null
    snapshot.modelId = this.currentModelId
    snapshot.contextWindow = this.windowInfo.contextWindow
    snapshot.windowSource = this.windowInfo.windowSource
    snapshot.lastObservationFollowedShrink = this.lastObservationFollowedShrink
    if (this.observation) {
      // A live observation exists: the projection carries provider facts.
      snapshot.estimateSource = 'provider'
      snapshot.confidence = 'authoritative'
    } else {
      snapshot.estimateSource = 'unknown'
      snapshot.confidence = 'heuristic'
    }
    return snapshot
  }
}
