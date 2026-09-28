/**
 * ContextSnapshot (plan 577 Phase 2) — the lineage-carrying context state
 * every consumer reads instead of recomputing its own number.
 *
 * Phase 1 split the vocabulary into Observation (provider facts, verbatim)
 * and Accounting State (harness-derived latest/peak/projected). Phase 2 adds
 * PROVENANCE: any number can now answer "which request, which model, which
 * window, measured when, and how much should I trust it".
 *
 *   - `confidence` distinguishes the three trust tiers the UI may surface:
 *     'authoritative' (a live provider observation drives the value),
 *     'derived' (projection from a real observation + deltas),
 *     'heuristic' (char-based estimate, no observation at all).
 *   - `observedAt` vs `lastUpdatedAt`: "150K measured 10ms ago" and "150K
 *     measured 3 tool calls ago" are different claims about the world.
 *   - `estimateSource` gains a fifth value 'unknown' (no data at all —
 *     post-compaction before the next response, fresh session).
 *   - `windowSource` mirrors resolveContextWindow so "the ring reads 1M while
 *     compaction fires at the 200K fallback" can no longer happen silently.
 *   - `epoch` — the ContextLedger's generation counter. Observations from a
 *     stale epoch are dropped by the ledger; consumers can detect a reset.
 *   - `anchorRequestId` / `anchorTurnId` — request lineage (plan 561 will
 *     back these with the model-call-trace rollout rows; null until then).
 *
 * Serialization is part of the contract: the snapshot crosses the worker →
 * renderer boundary inside `token_usage` frames and must round-trip.
 */

import type { ContextObservation, ContextAccountingState } from './context-accounting.js'
import type { ContextWindowSource } from './context-window.js'

/** Phase 1's four sources plus 'unknown' — a snapshot with nothing behind it. */
export type ContextSnapshotEstimateSource =
  | 'provider'
  | 'anchor_projection'
  | 'tokenizer'
  | 'heuristic'
  | 'unknown'

/** How much the snapshot's headline number should be trusted. */
export type ContextSnapshotConfidence = 'authoritative' | 'derived' | 'heuristic'

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1

export interface ContextSnapshot {
  schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION
  /** Latest provider observation, verbatim. `null` = none in this epoch. */
  observation: ContextObservation | null
  /** Harness-derived accounting state (latest / peak / projectedNext). */
  accounting: ContextAccountingState
  /** Where the headline number came from (five-value, § above). */
  estimateSource: ContextSnapshotEstimateSource
  confidence: ContextSnapshotConfidence
  /** When the latest observation was reported (0 = never). */
  observedAt: number
  /** When this snapshot's state last changed for any reason. */
  lastUpdatedAt: number
  /** Request lineage of the anchor — plan 561 fills these from the
   *  model-call-trace rollout rows; null until that wiring lands. */
  anchorRequestId: string | null
  anchorTurnId: string | null
  /** Model that produced the anchor (may differ from the current model
   *  after a mid-epoch switch — the context was billed by THIS model). */
  modelId: string | null
  /** Resolved context window for the current model + where it came from. */
  contextWindow: number
  windowSource: ContextWindowSource
  /** ContextLedger generation. Observations tagged with an older epoch are
   *  stale by definition and must not influence this snapshot. */
  epoch: number
  /** True when the latest observation was the FIRST one after a noted
   *  projection shrink (prune / offload) — the ring may correct its anchor
   *  downward from it. Provenance for applyLiveAnchorCorrection. */
  lastObservationFollowedShrink: boolean
}

/** A minimal, valid snapshot — nothing observed, nothing derived. */
export function emptyContextSnapshot(now = Date.now()): ContextSnapshot {
  return {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    observation: null,
    accounting: { projectedNextInputTokens: 0 },
    estimateSource: 'unknown',
    confidence: 'heuristic',
    observedAt: 0,
    lastUpdatedAt: now,
    anchorRequestId: null,
    anchorTurnId: null,
    modelId: null,
    contextWindow: 0,
    windowSource: 'default',
    epoch: 0,
    lastObservationFollowedShrink: false,
  }
}

/** JSON round-trip. Returns `null` on malformed input or an unknown schema
 *  version (forward-compat: never trust a shape you don't know). */
export function serializeContextSnapshot(snapshot: ContextSnapshot): string {
  return JSON.stringify(snapshot)
}

export function deserializeContextSnapshot(json: string | null | undefined): ContextSnapshot | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<ContextSnapshot> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) return null
    const base = emptyContextSnapshot()
    const merged: ContextSnapshot = {
      ...base,
      ...parsed,
      schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
      // Never trust a deserialized accounting object wholesale — rebuild the
      // numeric guarantees (non-negative projected) defensively.
      accounting: {
        latestInputTokens: nonNegativeOrUndefined(parsed.accounting?.latestInputTokens),
        peakInputTokens: nonNegativeOrUndefined(parsed.accounting?.peakInputTokens),
        projectedNextInputTokens: Math.max(0, Number(parsed.accounting?.projectedNextInputTokens) || 0),
      },
      observation:
        parsed.observation && typeof parsed.observation === 'object' && typeof parsed.observation.inputTokens === 'number'
          ? parsed.observation
          : null,
    }
    return merged
  } catch {
    return null
  }
}

function nonNegativeOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
