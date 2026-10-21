/**
 * Plan 577 Phase 2 — ContextLedger: the single observation entry point.
 *
 * Locks:
 * ① epoch isolation — an observation tagged with a stale epoch (a result
 *    still in flight from before a compaction rewrote the timeline) is
 *    DROPPED; the ring must not be dragged back to pre-compaction volumes.
 * ② beginEpoch(reason) rollover semantics for every reason — observation,
 *    accounting state and shrink provenance reset; the epoch counter
 *    increments (window/model lineage survives).
 * ③ model switch does NOT rollover — a budget change is not a context
 *    lineage rebuild (plan 577 §3 review round 2).
 * ④ accounting semantics migrated verbatim from the Phase 1 manager
 *    (shrink-gated latest, per-epoch peak, output ≠ anchor).
 * ⑤ consumer coherence — the manager-facing API and the snapshot describe
 *    the same state (the "read one state" property Phase 2 exists for).
 */

import { describe, it, expect } from 'vitest';
import { ContextLedger } from '../ContextLedger.js';
import { deserializeContextSnapshot, serializeContextSnapshot } from '@duya/ai';

describe('ContextLedger ① — epoch isolation', () => {
  it('drops a stale-epoch observation instead of dragging the ring backwards', () => {
    const ledger = new ContextLedger();
    ledger.recordObservation({ inputTokens: 180_000, outputTokens: 5_000 });
    expect(ledger.getPeakInputTokens()).toBe(180_000);

    // Compaction rewrites the lineage.
    const newEpoch = ledger.beginEpoch('compaction');
    expect(newEpoch).toBe(1);

    // A late result from the PRE-compaction request arrives, tagged with
    // the epoch it was built under.
    const accepted = ledger.recordObservation({
      inputTokens: 180_000,
      outputTokens: 5_000,
      epoch: 0,
    });
    expect(accepted).toBe(false);
    expect(ledger.getObservation()).toBeNull();
    expect(ledger.getPeakInputTokens()).toBeUndefined();

    // The post-compaction observation (current epoch) lands normally.
    expect(
      ledger.recordObservation({ inputTokens: 40_000, outputTokens: 2_000, epoch: newEpoch }),
    ).toBe(true);
    expect(ledger.getLatestInputTokens()).toBe(40_000);
  });

  it('accepts observations without an explicit epoch (trusted in-order callers)', () => {
    const ledger = new ContextLedger();
    ledger.beginEpoch('clear');
    expect(ledger.recordObservation({ inputTokens: 1_000, outputTokens: 0 })).toBe(true);
    expect(ledger.getLatestInputTokens()).toBe(1_000);
  });
});

describe('ContextLedger ② — beginEpoch(reason) rollover semantics', () => {
  it.each(['compaction', 'clear', 'restore', 'fork'] as const)(
    'reason %s resets observation/accounting/shrink and increments the epoch',
    (reason) => {
      const ledger = new ContextLedger();
      ledger.setWindowInfo({ contextWindow: 200_000, windowSource: 'capability' });
      ledger.noteSchemaEstimate(10_000);
      ledger.recordObservation({ inputTokens: 120_000, outputTokens: 8_000 });
      ledger.noteProjectionShrink();
      expect(ledger.getEpoch()).toBe(0);

      const epoch = ledger.beginEpoch(reason);

      expect(epoch).toBe(1);
      expect(ledger.getObservation()).toBeNull();
      expect(ledger.getLatestInputTokens()).toBeUndefined();
      expect(ledger.getPeakInputTokens()).toBeUndefined();
      expect(ledger.wasLastObservationPostShrink()).toBe(false);
      expect(ledger.getAccountingState().projectedNextInputTokens).toBe(0);
      // Window lineage survives the reset (the runtime did not change).
      expect(ledger.getWindowInfo()).toEqual({ contextWindow: 200_000, windowSource: 'capability' });

      // The schema baseline dropped with the epoch: the next observation
      // re-takes it, so the delta restarts at 0.
      ledger.noteSchemaEstimate(35_000);
      ledger.recordObservation({ inputTokens: 50_000, outputTokens: 0 });
      expect(ledger.getAccountingState().projectedNextInputTokens).toBe(50_000);
    },
  );

  it('epochs accumulate monotonically across multiple resets', () => {
    const ledger = new ContextLedger();
    ledger.beginEpoch('compaction');
    ledger.beginEpoch('clear');
    const epoch = ledger.beginEpoch('restore');
    expect(epoch).toBe(3);
    expect(ledger.getEpoch()).toBe(3);
  });
});

describe('ContextLedger ③ — model switch does not rollover', () => {
  it('keeps observations and accounting state across noteModelSwitch', () => {
    const ledger = new ContextLedger();
    ledger.recordObservation({ inputTokens: 100_000, outputTokens: 4_000 });
    ledger.noteModelSwitch(
      { contextWindow: 1_000_000, windowSource: 'capability' },
      'glm-4.7-big',
    );

    expect(ledger.getEpoch()).toBe(0); // no rollover
    expect(ledger.getLatestInputTokens()).toBe(100_000);
    expect(ledger.getPeakInputTokens()).toBe(100_000);
    expect(ledger.getObservation()?.inputTokens).toBe(100_000);

    const snapshot = ledger.getSnapshot();
    expect(snapshot.contextWindow).toBe(1_000_000);
    expect(snapshot.windowSource).toBe('capability');
    expect(snapshot.modelId).toBe('glm-4.7-big');
  });
});

describe('ContextLedger ④ — accounting semantics (Phase 1 parity)', () => {
  it('latest falls only across a noted shrink; peak never falls within an epoch', () => {
    const ledger = new ContextLedger();
    ledger.recordObservation({ inputTokens: 112_000, outputTokens: 4_000 });
    ledger.noteProjectionShrink();
    ledger.recordObservation({ inputTokens: 88_000, outputTokens: 4_000 });
    expect(ledger.getLatestInputTokens()).toBe(88_000);
    expect(ledger.getPeakInputTokens()).toBe(112_000);
    expect(ledger.wasLastObservationPostShrink()).toBe(true);
    // Output volume is not a prompt delta; only persisted timeline content
    // can add to the next-input projection.
    expect(ledger.getAccountingState().projectedNextInputTokens).toBe(88_000);

    // Next round without a shrink: the max-defense returns.
    ledger.recordObservation({ inputTokens: 70_000, outputTokens: 0 });
    expect(ledger.getLatestInputTokens()).toBe(88_000);
    expect(ledger.wasLastObservationPostShrink()).toBe(false);
  });

  it('output never joins the anchor and schema growth is felt by the projection', () => {
    const ledger = new ContextLedger();
    ledger.noteSchemaEstimate(10_000);
    ledger.recordObservation({ inputTokens: 100_000, outputTokens: 20_000 });
    expect(ledger.getPeakInputTokens()).toBe(100_000);
    expect(ledger.getAccountingState().projectedNextInputTokens).toBe(100_000);

    // MCP server loads: +25k of tool definitions — the NEXT request carries
    // them without waiting for a provider report.
    ledger.noteSchemaEstimate(35_000);
    expect(ledger.getAccountingState().projectedNextInputTokens).toBe(125_000);
  });

  it('rejects non-positive inputs and clamps negative output', () => {
    const ledger = new ContextLedger();
    expect(ledger.recordObservation({ inputTokens: 0, outputTokens: 1_000 })).toBe(false);
    expect(ledger.recordObservation({ inputTokens: -5, outputTokens: 1_000 })).toBe(false);
    expect(ledger.recordObservation({ inputTokens: 1_000, outputTokens: -3 })).toBe(true);
    expect(ledger.getObservation()?.outputTokens).toBe(0);
  });
});

describe('ContextLedger ⑤ — snapshot coherence and round-trip', () => {
  it('snapshot reflects observation presence as estimateSource/confidence', () => {
    const ledger = new ContextLedger();
    const empty = ledger.getSnapshot();
    expect(empty.estimateSource).toBe('unknown');
    expect(empty.confidence).toBe('heuristic');
    expect(empty.epoch).toBe(0);

    ledger.recordObservation({ inputTokens: 90_000, outputTokens: 1_000 });
    const filled = ledger.getSnapshot();
    expect(filled.estimateSource).toBe('provider');
    expect(filled.confidence).toBe('authoritative');
    expect(filled.observation?.inputTokens).toBe(90_000);
    expect(filled.accounting.peakInputTokens).toBe(90_000);
    expect(filled.observedAt).toBeGreaterThan(0);
  });

  it('snapshot serializes and restores losslessly', () => {
    const ledger = new ContextLedger();
    ledger.setWindowInfo({ contextWindow: 200_000, windowSource: 'catalog' });
    ledger.noteModelSwitch({ contextWindow: 200_000, windowSource: 'catalog' }, 'test-model');
    ledger.recordObservation({ inputTokens: 64_000, outputTokens: 2_000, requestId: 'req-9' });

    const snapshot = ledger.getSnapshot();
    const restored = deserializeContextSnapshot(serializeContextSnapshot(snapshot));
    expect(restored).toEqual(snapshot);
    expect(restored?.anchorRequestId).toBe('req-9');
    expect(restored?.modelId).toBe('test-model');
  });
});
