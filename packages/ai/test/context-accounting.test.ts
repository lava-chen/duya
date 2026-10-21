/**
 * Plan 577 Phase 1 — context accounting pure-function tests.
 *
 * Locks the two-layer vocabulary at the type/behavior level:
 * - `projectNextInput`: output NEVER leaks into the projection implicitly —
 *   only caller-supplied persisted/pending/schema/system deltas count
 *   (review round 2, test ③ semantics).
 * - `applyLiveAnchorCorrection`: the ring anchor follows fresh provider
 *   observations upward (result→push staleness window) and — only across a
 *   noted projection shrink — downward (prune fallback, test ①). Without
 *   that provenance a direction guard keeps GLM-style under-report rounds
 *   from collapsing the anchor mid-turn.
 */

import { describe, it, expect } from 'vitest';
import {
  applyLiveAnchorCorrection,
  projectNextInput,
} from '../src/utils/context-accounting.js';

describe('projectNextInput', () => {
  it('adds only caller-supplied deltas to the base observation', () => {
    expect(
      projectNextInput({
        baseObservation: { inputTokens: 100_000 },
        persistedDelta: 5_000,
      }),
    ).toBe(105_000);
  });

  it('ignores outputTokens entirely — persist facts, not generation volume, drive the projection (test ③)', () => {
    // input 100k / output 20k of which reasoning 15k and only 5k persists:
    // the projection must read 105k. The function has no output parameter at
    // all — the type is the lock; this assertion pins the arithmetic.
    const outputThatWasReported = 20_000;
    expect(
      projectNextInput({
        baseObservation: { inputTokens: 100_000 },
        persistedDelta: 5_000,
      }),
    ).toBe(100_000 + 5_000);
    expect(outputThatWasReported).toBe(20_000);
  });

  it('folds pending and schema deltas (schema growth is felt before the next provider report)', () => {
    expect(
      projectNextInput({
        baseObservation: { inputTokens: 100_000 },
        pendingDelta: 4_000,
        schemaDelta: 25_000,
      }),
    ).toBe(129_000);
  });

  it('degrades to the deltas alone when no base observation exists', () => {
    expect(projectNextInput({ persistedDelta: 1_000, schemaDelta: 2_000 })).toBe(3_000);
    expect(projectNextInput({})).toBe(0);
  });

  it('clamps negative delta sums to 0', () => {
    expect(
      projectNextInput({ baseObservation: { inputTokens: 50 }, persistedDelta: -10 }),
    ).toBe(50);
  });
});

describe('applyLiveAnchorCorrection', () => {
  it('test ① prune: replaces the projected input DOWNWARD after a shrink', () => {
    // The provider input already contains the request's trailing messages;
    // do not add them or output volume a second time.
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 117_500,
      scanAnchorInputTokens: 112_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: false,
      liveLatestInputTokens: 88_000,
      schemaDelta: 0,
      shrinkArmed: true,
    });
    expect(result.replaced).toBe(true);
    expect(result.usedTokens).toBe(88_000);
    expect(result.estimateSource).toBe('provider');
  });

  it('keeps the direction guard without shrink provenance (GLM under-report defense)', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 117_500,
      scanAnchorInputTokens: 112_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: false,
      liveLatestInputTokens: 60_000,
      schemaDelta: 0,
      shrinkArmed: false,
    });
    expect(result.replaced).toBe(false);
    expect(result.usedTokens).toBe(117_500);
    expect(result.estimateSource).toBe('anchor_projection');
  });

  it('uses full observed input in result→push window without double-counting trailing messages', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 102_000,
      scanAnchorInputTokens: 100_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: false,
      liveLatestInputTokens: 120_000,
      schemaDelta: 0,
      shrinkArmed: false,
    });
    expect(result.replaced).toBe(true);
    expect(result.usedTokens).toBe(120_000);
  });

  it('keeps persisted assistant content once the timeline contains the live observation', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 128_000,
      scanAnchorInputTokens: 120_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: true,
      liveLatestInputTokens: 120_000,
      schemaDelta: 0,
      shrinkArmed: false,
    });
    expect(result.replaced).toBe(false);
    expect(result.usedTokens).toBe(128_000);
  });

  it('preserves the protected latest input when the timeline captured an under-reported observation', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 61_000,
      scanAnchorInputTokens: 60_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: true,
      liveLatestInputTokens: 100_000,
      schemaDelta: 0,
      shrinkArmed: false,
    });
    expect(result.usedTokens).toBe(101_000);
    expect(result.estimateSource).toBe('provider');
  });

  it('stands down when no live observation exists', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: 90_500,
      scanAnchorInputTokens: 90_000,
      scanAnchored: true,
      timelineIncludesLiveObservation: false,
      liveLatestInputTokens: 0,
      schemaDelta: 0,
      shrinkArmed: true, // even armed — nothing to replace with
    });
    expect(result.replaced).toBe(false);
    expect(result.usedTokens).toBe(90_500);
  });

  it('uses live input and schema growth when no timeline anchor exists', () => {
    const result = applyLiveAnchorCorrection({
      scanUsedTokens: null,
      scanAnchorInputTokens: 0,
      scanAnchored: false,
      timelineIncludesLiveObservation: false,
      liveLatestInputTokens: 80_000,
      schemaDelta: 3_000,
      shrinkArmed: false,
    });
    expect(result.usedTokens).toBe(83_000);
    expect(result.estimateSource).toBe('provider');
  });
});
