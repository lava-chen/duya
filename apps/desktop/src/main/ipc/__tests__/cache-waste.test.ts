import { describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, computeCacheWaste, type CacheSequenceEntry } from '../cache-waste';
import type { UsagePricing } from '../usage-aggregator';

const PRICING: UsagePricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

function usage(
  ts: number,
  parts: { input: number; cacheRead?: number; cacheWrite?: number },
): CacheSequenceEntry {
  return {
    kind: 'usage',
    ts,
    input: parts.input,
    output: 100,
    cacheRead: parts.cacheRead ?? 0,
    cacheWrite: parts.cacheWrite ?? 0,
  };
}

describe('computeCacheWaste', () => {
  it('returns zeros for a single-turn session (no baseline to miss against)', () => {
    const r = computeCacheWaste([usage(0, { input: 50_000, cacheWrite: 50_000 })], PRICING);
    expect(r.missCount).toBe(0);
    expect(r.missedTokens).toBe(0);
    expect(r.missedCost).toBe(0);
  });

  it('counts a full-prompt re-bill when the second turn reads nothing from cache', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        // Same prompt size, zero cache read → all ~49k cached tokens re-billed at input rate.
        usage(60_000, { input: 50_000 }),
      ],
      PRICING,
    );
    expect(r.missCount).toBe(1);
    expect(r.missedTokens).toBe(50_000);
    // paid rate = input $3/M; read rate = $0.3/M → diff = 2.7 / M
    expect(r.missedCost).toBeCloseTo((50_000 * (3 - 0.3)) / 1_000_000, 8);
    expect(r.ttlExpiredMissCount).toBe(0); // 60s idle < 5min TTL
  });

  it('ignores misses at or below the 1024-token noise floor', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 10_000, cacheWrite: 10_000 }),
        usage(1_000, { input: 500, cacheRead: 19_500 }), // missed = min(20k,20k) - 19.5k = 500
      ],
      PRICING,
    );
    expect(r.missCount).toBe(0);
  });

  it('caps missed tokens at the previous prompt size (post-compaction shrink is normal)', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 5_000, cacheWrite: 5_000 }),
        usage(1_000, { input: 3_000 }), // prompt shrank to 3k; missed capped at 10k... but read=0
      ],
      PRICING,
    );
    // missed = min(prev.prompt=10k, cur.prompt=3k) - 0 = 3k
    expect(r.missedTokens).toBe(3_000);
  });

  it('does not count providers that never report caching (no sticky cache activity)', () => {
    const r = computeCacheWaste(
      [usage(0, { input: 50_000 }), usage(1_000, { input: 50_000 })],
      PRICING,
    );
    // First turn establishes no reportedCache; second turn zero-cache + !reportedCache → skip
    expect(r.missCount).toBe(0);
  });

  it('counts a total miss on cache-read-only providers once cache activity was seen (sticky)', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 2_000, cacheRead: 48_000 }),
        usage(1_000, { input: 50_000 }), // zero-cache turn AFTER cache was reported → total miss
      ],
      PRICING,
    );
    expect(r.missCount).toBe(1);
    expect(r.missedTokens).toBe(50_000);
  });

  it('resets the baseline after a compaction boundary (new content, not re-billed)', () => {
    const entries: CacheSequenceEntry[] = [
      usage(0, { input: 1_000, cacheWrite: 49_000 }),
      { kind: 'compaction' },
      usage(1_000, { input: 50_000 }),
    ];
    const r = computeCacheWaste(entries, PRICING);
    expect(r.missCount).toBe(0);
  });

  it('does NOT exempt model switches — they re-bill the full prompt', () => {
    // duya rows carry session-level model only, so a switch looks like any
    // other pair of turns; the scanner must still count the re-bill.
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        usage(1_000, { input: 50_000 }),
      ],
      PRICING,
    );
    expect(r.missCount).toBe(1);
  });

  it('flags misses whose idle gap exceeds the cache TTL as likely expiry', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        usage(CACHE_TTL_MS + 60_000, { input: 50_000 }),
      ],
      PRICING,
    );
    expect(r.missCount).toBe(1);
    expect(r.ttlExpiredMissCount).toBe(1);
    expect(r.misses[0].idleBeyondTtl).toBe(true);
  });

  it('degrades to token-only accounting when pricing is unknown', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        usage(1_000, { input: 50_000 }),
      ],
      undefined,
    );
    expect(r.missedTokens).toBe(50_000);
    expect(r.missedCost).toBe(0);
  });

  it('blends write premium into the paid rate for partially-written prompts', () => {
    // prev prompt 40k; this turn: input=1k fresh, cacheWrite=39k re-created,
    // cacheRead=0. Missed = 40k. Paid blended rate = (1k*3 + 39k*3.75)/40k per token.
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 39_000 }),
        usage(1_000, { input: 1_000, cacheWrite: 39_000 }),
      ],
      PRICING,
    );
    const paidPerToken = (1_000 * 3 + 39_000 * 3.75) / 40_000;
    expect(r.missedCost).toBeCloseTo((40_000 * (paidPerToken - 0.3)) / 1_000_000, 8);
  });
});

describe('computeCacheWaste — per-entry pricing (token accounting)', () => {
  const MODEL_A: UsagePricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  };
  const MODEL_B: UsagePricing = {
    inputPerMillion: 10,
    outputPerMillion: 30,
    cacheReadPerMillion: 1,
    cacheWritePerMillion: 12.5,
  };
  const lookup = (model: string) => (model === 'model-a' ? MODEL_A : model === 'model-b' ? MODEL_B : undefined);

  it('model_change boundary does NOT reset the baseline (switch re-bills the prompt)', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        { kind: 'model_change', ts: 500 },
        usage(1_000, { input: 50_000 }),
      ],
      PRICING,
    );
    expect(r.missCount).toBe(1);
    expect(r.missedTokens).toBe(50_000);
  });

  it('prices a post-switch miss at the NEW model rates (model-a write → model-b input)', () => {
    const r = computeCacheWaste(
      [
        { kind: 'usage', ts: 0, input: 1_000, output: 100, cacheRead: 0, cacheWrite: 49_000, model: 'model-a', providerId: 'prov' },
        { kind: 'model_change', ts: 500 },
        { kind: 'usage', ts: 1_000, input: 50_000, output: 100, cacheRead: 0, cacheWrite: 0, model: 'model-b', providerId: 'prov' },
      ],
      MODEL_A, // session fallback (model-a)
      (model) => lookup(model),
    );
    expect(r.missCount).toBe(1);
    expect(r.missedTokens).toBe(50_000);
    // Missed tokens billed at model-b input rate vs model-b cache-read rate.
    expect(r.missedCost).toBeCloseTo((50_000 * (10 - 1)) / 1_000_000, 8);
  });

  it('legacy entries without model info fall back to the session pricing table', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        usage(1_000, { input: 50_000 }),
      ],
      MODEL_A,
      (model) => lookup(model),
    );
    expect(r.missedCost).toBeCloseTo((50_000 * (3 - 0.3)) / 1_000_000, 8);
  });

  it('a model-carrying entry with unknown pricing degrades to token-only waste (no session mispricing)', () => {
    const r = computeCacheWaste(
      [
        usage(0, { input: 1_000, cacheWrite: 49_000 }),
        { kind: 'usage', ts: 1_000, input: 50_000, output: 100, cacheRead: 0, cacheWrite: 0, model: 'unknown-model', providerId: 'prov' },
      ],
      MODEL_A,
      (model) => lookup(model),
    );
    expect(r.missCount).toBe(1);
    expect(r.missedTokens).toBe(50_000);
    expect(r.missedCost).toBe(0);
  });
});
