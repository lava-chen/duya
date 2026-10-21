/**
 * Plan 577 Phase 2 — ContextSnapshot type + serialization contract.
 *
 * The snapshot is the lineage-carrying state every consumer reads; it
 * crosses the worker → renderer boundary inside `token_usage` frames, so
 * the JSON round-trip is part of the contract, not an implementation
 * detail.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyContextSnapshot,
  serializeContextSnapshot,
  deserializeContextSnapshot,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
} from '../src/utils/context-snapshot.js';

function fullSnapshot(): ContextSnapshot {
  return {
    ...emptyContextSnapshot(1000),
    observation: {
      inputTokens: 150_000,
      outputTokens: 4_000,
      source: 'provider',
      requestId: 'req-1',
      observedAt: 1700,
    },
    accounting: {
      latestInputTokens: 150_000,
      peakInputTokens: 170_000,
      projectedNextInputTokens: 158_000,
    },
    estimateSource: 'provider',
    confidence: 'authoritative',
    observedAt: 1700,
    lastUpdatedAt: 1800,
    anchorRequestId: 'req-1',
    anchorTurnId: null,
    modelId: 'glm-4.7',
    contextWindow: 200_000,
    windowSource: 'capability',
    epoch: 3,
    lastObservationFollowedShrink: true,
  };
}

describe('ContextSnapshot (plan 577 §3)', () => {
  it('empty snapshot: unknown source, heuristic confidence, zero epoch', () => {
    const s = emptyContextSnapshot();
    expect(s.schemaVersion).toBe(CONTEXT_SNAPSHOT_SCHEMA_VERSION);
    expect(s.observation).toBeNull();
    expect(s.estimateSource).toBe('unknown');
    expect(s.confidence).toBe('heuristic');
    expect(s.epoch).toBe(0);
    expect(s.accounting.projectedNextInputTokens).toBe(0);
  });

  it('serialize → deserialize round-trips every field', () => {
    const original = fullSnapshot();
    const restored = deserializeContextSnapshot(serializeContextSnapshot(original));
    expect(restored).toEqual(original);
  });

  it('deserialize rejects malformed JSON and unknown schema versions', () => {
    expect(deserializeContextSnapshot('not json at all {')).toBeNull();
    expect(deserializeContextSnapshot(null)).toBeNull();
    expect(deserializeContextSnapshot(undefined)).toBeNull();
    expect(deserializeContextSnapshot('42')).toBeNull();

    const bad = { ...fullSnapshot(), schemaVersion: 999 };
    expect(deserializeContextSnapshot(JSON.stringify(bad))).toBeNull();
  });

  it('deserialize repairs non-numeric accounting values instead of trusting them', () => {
    const json = JSON.stringify({
      ...fullSnapshot(),
      accounting: { latestInputTokens: 'oops', peakInputTokens: -5, projectedNextInputTokens: NaN },
    });
    const restored = deserializeContextSnapshot(json)!;
    expect(restored).not.toBeNull();
    expect(restored.accounting.latestInputTokens).toBeUndefined();
    expect(restored.accounting.peakInputTokens).toBeUndefined();
    expect(restored.accounting.projectedNextInputTokens).toBe(0);
  });

  it('deserialize nulls out a corrupt observation', () => {
    const json = JSON.stringify({ ...fullSnapshot(), observation: { inputTokens: 'nope' } });
    const restored = deserializeContextSnapshot(json)!;
    expect(restored.observation).toBeNull();
  });
});
