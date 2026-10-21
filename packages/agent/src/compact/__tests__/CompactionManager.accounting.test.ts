/**
 * Plan 577 Phase 1 — CompactionManager accounting-state tests.
 *
 * Locks the §2 core semantics:
 * ① prune — an observation after a noted projection shrink replaces the
 *    accounting `latest` even when smaller; `peak` keeps the high-water mark.
 * ② tool schema mutation — a schema grown after the last observation is felt
 *    by the projection immediately (contextSize += schemaDelta) without
 *    waiting for the next provider report.
 * ③ output ≠ next input delta — the Observation layer records input and
 *    output separately; output never inflates latest/peak or projected input.
 *    Only persisted message content contributes to the shared projection.
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '../../types.js';
import { CompactionManager } from '../CompactionManager.js';

/** One assistant message carrying a provider usage block — the timeline scan
 *  anchors on it (normalizePromptTokens: no cache fields → prompt = input). */
function anchoredHistory(inputTokens: number, outputTokens: number): Message[] {
  return [
    {
      role: 'assistant',
      content: 'answer',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    } as unknown as Message,
  ];
}

describe('Plan 577 §2 ① — prune fallback (latest falls, peak keeps)', () => {
  it('replaces latest downward after noteProjectionShrink and keeps peak at the pre-prune mark', () => {
    const manager = new CompactionManager();

    // call#2: 112k input observed (turn peak so far).
    manager.setObservedUsage(112_000, 4_000);
    expect(manager.getLatestInputTokens()).toBe(112_000);
    expect(manager.getPeakInputTokens()).toBe(112_000);

    // Prune / offload shrank the projection between call#2 and call#3.
    manager.noteProjectionShrink();
    expect(manager.wasLastObservationPostShrink()).toBe(false);

    // call#3 reports 88k — genuinely smaller because of the prune.
    manager.setObservedUsage(88_000, 4_000);
    expect(manager.getLatestInputTokens()).toBe(88_000); // fell ✓
    expect(manager.getPeakInputTokens()).toBe(112_000); // kept ✓
    expect(manager.wasLastObservationPostShrink()).toBe(true);

    // Output volume is not persisted content.
    expect(manager.getAccountingState().projectedNextInputTokens).toBe(88_000);
  });

  it('without shrink provenance a smaller observation is treated as an under-report', () => {
    const manager = new CompactionManager();
    manager.setObservedUsage(112_000, 4_000);
    // GLM-style near-fresh-prefix round reports far below the real context.
    manager.setObservedUsage(60_000, 2_000);
    expect(manager.getLatestInputTokens()).toBe(112_000); // max-defense kept it
    expect(manager.getPeakInputTokens()).toBe(112_000);
    expect(manager.wasLastObservationPostShrink()).toBe(false);
  });

  it('a post-shrink observation restores normal max-defense afterwards', () => {
    const manager = new CompactionManager();
    manager.setObservedUsage(112_000, 0);
    manager.noteProjectionShrink();
    manager.setObservedUsage(88_000, 0);
    // Next round, no shrink: smaller reports can no longer pull latest down.
    manager.setObservedUsage(70_000, 0);
    expect(manager.getLatestInputTokens()).toBe(88_000);
    expect(manager.wasLastObservationPostShrink()).toBe(false);
  });
});

describe('Plan 577 §2 ② — tool schema mutation is felt by the projection', () => {
  it('adds the schemaDelta to an anchored scan without waiting for the next provider report', () => {
    // Tight budget so the trigger line flip is observable: 120k window →
    // trigger = 120_000 - 16_384 = 103_616.
    const manager = new CompactionManager({ maxTokens: 120_000 });
    const messages = anchoredHistory(95_000, 5_000); // scan anchor = 100k

    // Baseline: call#1 ran with a 10k schema surface.
    manager.setSchemaEstimateTokens(10_000);
    manager.setObservedUsage(100_000, 5_000);
    expect(manager.getContextTokens(messages)).toBe(100_000);
    expect(manager.probeCompaction(messages).overTriggerLine).toBe(false);

    // A large MCP server loads mid-session: +25k of tool definitions. The
    // NEXT request carries them — the projection must rise immediately.
    manager.setSchemaEstimateTokens(35_000);
    expect(manager.getContextTokens(messages)).toBe(125_000);
    expect(manager.probeCompaction(messages).overTriggerLine).toBe(true);
  });
});

describe('Plan 577 §3 — one enriched snapshot drives budget and ring', () => {
  it('uses persisted assistant content and excludes provider output volume', () => {
    const manager = new CompactionManager();
    const messages = [
      {
        role: 'assistant',
        content: 'answer', // 2 estimated tokens actually persisted
        usage: { input_tokens: 100_000, output_tokens: 20_000 },
      } as unknown as Message,
    ];
    manager.setObservedUsage(100_000, 20_000);

    const snapshot = manager.getContextSnapshot(messages);
    expect(snapshot.accounting.projectedNextInputTokens).toBe(100_002);
    expect(manager.getContextTokens(messages)).toBe(
      snapshot.accounting.projectedNextInputTokens,
    );
    expect(snapshot.estimateSource).toBe('anchor_projection');
  });
});

describe('Plan 577 §2 ③ — output is not part of the anchor', () => {
  it('records output separately; latest/peak never inflate with it', () => {
    const manager = new CompactionManager();
    // input 100k / output 20k (of which reasoning 15k would not persist).
    manager.setObservedUsage(100_000, 20_000);

    expect(manager.getObservedPromptTokens()).toBe(100_000); // input only
    expect(manager.getLatestInputTokens()).toBe(100_000);
    expect(manager.getPeakInputTokens()).toBe(100_000);

    // The ledger has no message timeline, so its base projection remains
    // input-only until CompactionManager enriches it from persisted content.
    expect(manager.getAccountingState().projectedNextInputTokens).toBe(100_000);

    // call#2 observes reality: 105k input (100k + 5k persisted). It replaces
    // the projection's guess — output never stuck to the anchor.
    manager.setObservedUsage(105_000, 2_000);
    expect(manager.getLatestInputTokens()).toBe(105_000);
    expect(manager.getPeakInputTokens()).toBe(105_000);
    expect(manager.getAccountingState().projectedNextInputTokens).toBe(105_000);
  });
});

describe('Plan 577 §2 — accounting epoch reset', () => {
  it('clearObservedPromptTokens resets observation, accounting and shrink provenance', () => {
    const manager = new CompactionManager();
    manager.setSchemaEstimateTokens(10_000);
    manager.setObservedUsage(112_000, 4_000);
    manager.noteProjectionShrink();
    manager.clearObservedPromptTokens();

    expect(manager.getObservedPromptTokens()).toBeUndefined();
    expect(manager.getLatestInputTokens()).toBeUndefined();
    expect(manager.getPeakInputTokens()).toBeUndefined();
    expect(manager.wasLastObservationPostShrink()).toBe(false);
    expect(manager.getAccountingState().projectedNextInputTokens).toBe(0);
    // The schema baseline dropped with the epoch — the next observation
    // re-takes it, so the delta restarts at 0.
    manager.setSchemaEstimateTokens(35_000);
    manager.setObservedUsage(50_000, 0);
    expect(manager.getAccountingState().projectedNextInputTokens).toBe(50_000);
  });

  it('probeCompaction carries the peak for overflow diagnostics', () => {
    const manager = new CompactionManager();
    manager.setObservedUsage(112_000, 4_000);
    expect(manager.probeCompaction(anchoredHistory(95_000, 5_000)).peakInputTokens).toBe(112_000);
    manager.clearObservedPromptTokens();
    expect(manager.probeCompaction(anchoredHistory(95_000, 5_000)).peakInputTokens).toBeUndefined();
  });
});
