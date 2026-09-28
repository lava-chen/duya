/**
 * Context accounting vocabulary (plan 577 Phase 1).
 *
 * Two STRICTLY SEPARATED layers — the whole point of Phase 1 is that these
 * never blur into one "token number":
 *
 *   Observation layer  — what the PROVIDER reported. Facts, recorded verbatim,
 *                        never interpreted. `inputTokens` is a direct
 *                        measurement of "the context actually submitted this
 *                        request"; `outputTokens` is just this call's
 *                        generation volume and says NOTHING about the next
 *                        prompt by itself.
 *   Accounting state   — what the HARNESS derives. `latest` can drop (prune /
 *                        offload shrank the projected context), `peak` never
 *                        does, `projectedNext` is what budget decisions must
 *                        compare against.
 *
 * Projection vocabulary (replaces the old "anchor + trailing" wording in
 * state-model contexts; "anchor" stays an implementation word inside
 * computeContextEstimate):
 *
 *   projection = baseObservation.inputTokens + persistedDelta + pendingDelta
 *                + schemaDelta + systemDelta
 *
 * `projectNextInput` is the single pure carrier of that formula so tests can
 * lock the semantics: output never leaks into the projection implicitly, and
 * a schema delta is felt by the NEXT request without waiting for a provider
 * report.
 */

/** Where a context number came from — mirrored into `ContextSnapshot` in
 *  Phase 2. Ordered by trust: provider > anchor_projection > tokenizer >
 *  heuristic. */
export type ContextEstimateSource =
  | 'provider'
  | 'anchor_projection'
  | 'tokenizer'
  | 'heuristic'

/**
 * Observation layer — one provider-reported usage fact. Recorded verbatim;
 * consumers must not "improve" it (no Math.max, no output folding).
 */
export interface ContextObservation {
  /** Full resident prompt the provider saw for THIS request (cache-aware
   *  normalized: input + cache read + cache write under the exclusive
   *  convention, raw input under the inclusive one). */
  inputTokens: number
  /** This call's generation volume. NOT part of the context projection. */
  outputTokens: number
  source: 'provider'
  /** Request lineage id when known (Phase 2 ledger fills this). */
  requestId: string
  /** When the provider reported it (Date.now()). */
  observedAt: number
}

/**
 * Accounting state layer — harness-derived context state. `latest` may fall
 * below `peak` after a legitimate shrink; `peak` is the high-water mark for
 * overflow diagnostics; `projectedNext` is the only value budget decisions
 * (proactive compaction trigger line) may compare against.
 */
export interface ContextAccountingState {
  /** Most recent observation's input. Can drop after a prune. */
  latestInputTokens?: number
  /** High-water mark of observed inputs since the last epoch reset
   *  (compaction / clear). Never falls within an epoch. */
  peakInputTokens?: number
  /** What the NEXT request is expected to submit. Budget decisions consume
   *  this, never `latest` or `peak` directly. */
  projectedNextInputTokens: number
}

/**
 * Pure projection: what the next request will submit.
 *
 * - `baseObservation` — the latest authoritative input observation. When
 *   absent the projection degrades to the deltas alone (caller decides
 *   whether that is meaningful).
 * - `persistedDelta` — content persisted since the observation that the next
 *   request will carry (assistant text/tool_use blocks the harness kept).
 * - `pendingDelta` — not-yet-observed content already queued for the next
 *   request (fresh tool results, injected runtime context).
 * - `schemaDelta` — tool-definition growth since the observation (MCP /
 *   skills loaded mid-session). Felt by the next request immediately — this
 *   is why the projection exists rather than re-reading the last raw report.
 * - `systemDelta` — system prompt growth since the observation.
 *
 * `outputTokens` of the base observation is deliberately IGNORED: output only
 * enters the next prompt through what the harness actually persisted, which
 * is `persistedDelta`'s job (reasoning-only output persists as 0 — plan 577
 * review round 2, test ③).
 */
export function projectNextInput(params: {
  baseObservation?: Pick<ContextObservation, 'inputTokens'> | null
  persistedDelta?: number
  pendingDelta?: number
  schemaDelta?: number
  systemDelta?: number
}): number {
  const base = Math.max(0, params.baseObservation?.inputTokens ?? 0)
  const deltas =
    (params.persistedDelta ?? 0) +
    (params.pendingDelta ?? 0) +
    (params.schemaDelta ?? 0) +
    (params.systemDelta ?? 0)
  return base + Math.max(0, deltas)
}

// ─── Live context projection (shared by compaction and the ring) ─────────────

export interface LiveAnchorCorrectionInput {
  /** Projected volume from the persisted timeline scan; null means unknown. */
  scanUsedTokens: number | null
  /** Prompt input measured at the scan's anchor, before persisted assistant
   *  content on that same message is added. */
  scanAnchorInputTokens: number
  /** Whether the scan has an authoritative timeline anchor. */
  scanAnchored: boolean
  /** True only when the scan's anchor is the observation currently in ledger. */
  timelineIncludesLiveObservation: boolean
  /** Accounting state's protected latest input (cache-aware normalized,
   *  WITHOUT output). 0 = no live observation. */
  liveLatestInputTokens: number
  /** Schema/system growth since the live observation. */
  schemaDelta: number
  /** True when the latest observation followed a projection shrink (prune /
   *  offload). Only then may the correction replace the anchor DOWNWARD;
   *  otherwise a direction guard keeps gateway under-reports (GLM-style
   *  near-fresh-prefix rounds) from collapsing the anchor mid-turn. */
  shrinkArmed: boolean
}

export interface LiveAnchorCorrectionResult {
  /** Shared current-input projection consumed by budget decisions and UI. */
  usedTokens: number
  /** True when the live observation changed the timeline projection. */
  replaced: boolean
  /** 'provider' when the live observation drove the number, else the scan's
   *  'anchor_projection', 'heuristic', or 'unknown'. */
  estimateSource: ContextEstimateSource | 'unknown'
}

/**
 * Resolve the current-input projection from the timeline and ledger.
 *
 * A provider input observation already includes the messages in its request,
 * so never add the timeline's trailing estimate to it. Once that observation
 * appears on the assistant timeline, the scan adds only the assistant content
 * that was actually persisted. Output-token volume itself is never a delta.
 *
 * The result is the one projection stored in ContextSnapshot and used by both
 * CompactionManager and the live ring. Shrink provenance permits a valid
 * downward correction; otherwise an under-report cannot pull an anchored
 * estimate down.
 */
export function applyLiveAnchorCorrection(
  input: LiveAnchorCorrectionInput,
): LiveAnchorCorrectionResult {
  const schemaDelta = Math.max(0, input.schemaDelta)
  const scan =
    input.scanUsedTokens === null
      ? undefined
      : Math.max(0, input.scanUsedTokens) + schemaDelta
  const hasLive = input.liveLatestInputTokens > 0
  const live = Math.max(0, input.liveLatestInputTokens) + schemaDelta

  if (input.scanAnchored && scan !== undefined) {
    if (!hasLive) {
      return {
        usedTokens: scan,
        replaced: false,
        estimateSource: 'anchor_projection',
      }
    }

    if (input.timelineIncludesLiveObservation) {
      // Preserve the ledger's max-defense when a gateway under-reports an
      // otherwise valid input-side counter, while retaining the actual
      // persisted assistant content and trailing messages from the scan.
      const scanTokens = Math.max(0, input.scanUsedTokens ?? 0)
      const persistedAfterAnchor = Math.max(
        0,
        scanTokens - input.scanAnchorInputTokens,
      )
      const protectedProjection =
        Math.max(0, input.liveLatestInputTokens) + persistedAfterAnchor + schemaDelta
      return {
        usedTokens: protectedProjection,
        replaced: protectedProjection !== scanTokens + schemaDelta,
        estimateSource:
          protectedProjection > scanTokens + schemaDelta ? 'provider' : 'anchor_projection',
      }
    }

    if (input.shrinkArmed || live > scan) {
      return {
        usedTokens: live,
        replaced: live !== scan,
        estimateSource: 'provider',
      }
    }

    return {
      usedTokens: scan,
      replaced: false,
      estimateSource: 'anchor_projection',
    }
  }

  if (hasLive) {
    return {
      usedTokens: live,
      replaced: true,
      estimateSource: 'provider',
    }
  }

  if (scan !== undefined && scan > 0) {
    return {
      usedTokens: scan,
      replaced: false,
      estimateSource: 'heuristic',
    }
  }

  return { usedTokens: 0, replaced: false, estimateSource: 'unknown' }
}
