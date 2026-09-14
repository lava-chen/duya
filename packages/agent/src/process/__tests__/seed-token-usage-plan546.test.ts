/**
 * Plan 546 regression tests for seedTokenUsageFromHistory.
 *
 * Plan 445 changed the persisted `tokenUsage` block on each assistant
 * message from single-call to turn-cumulative (sum of every LLM call
 * in the turn + `last_call` snapshot + `calls[]` ledger). The seed
 * loop at the top of `handleChatStart` continued to sum the top-level
 * fields directly, which double-counted every turn whose `result`
 * handler ALSO accumulated per-call `rawInput` into the live counters.
 * Over N turns the cumulative total grew ~N× the real session volume
 * (1720M / 1.0M screenshots).
 *
 * The fix walks the per-call ledger first (plan 445+), then `last_call`,
 * then the legacy single-call block. These tests pin the new shape.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveSingleCallUsage,
  seedTokenUsageFromHistory,
} from '../seed-token-usage.js';
import type { Message, TokenUsage } from '@duya/ai';

function msg(tokenUsage: TokenUsage | null | undefined): Message {
  return {
    role: 'assistant',
    id: 'a',
    content: [{ type: 'text', text: 'x' }],
    timestamp: 0,
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
  } as Message;
}

function call(input: number, output: number, cacheHit = 0, cacheCreate = 0): TokenUsage['calls'] extends Array<infer C> ? C : never {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_hit_tokens: cacheHit,
    cache_creation_tokens: cacheCreate,
  } as TokenUsage['calls'] extends Array<infer C> ? C : never;
}

describe('seedTokenUsageFromHistory (plan 546)', () => {
  it('walks the per-call ledger and never the turn-cumulative top-level fields', () => {
    // A multi-call turn where plan 445 wrote the turn-cumulative top-level
    // input (= sum of all three calls) ALONGSIDE the calls[] ledger.
    // The seed must sum the calls only, not the top-level input. Use
    // small cache counters (< rawInput) so the cache-convention guard
    // takes the simple `normalized = rawInput` path and the math is
    // straight per-call sums.
    const cumulative: TokenUsage = {
      input_tokens: 50 + 30 + 70, // turn-cumulative sum, do NOT use
      output_tokens: 8 + 7 + 10,
      total_tokens: 175,
      cache_hit_tokens: 5 + 3 + 7, // < rawInput per call, simple path
      cache_creation_tokens: 1 + 0 + 2,
      calls: [call(50, 8, 5, 1), call(30, 7, 3, 0), call(70, 10, 7, 2)],
      last_call: { input_tokens: 70, output_tokens: 10, cache_hit_tokens: 7, cache_creation_tokens: 2 },
    };

    const totals = seedTokenUsageFromHistory([msg(cumulative)]);

    // Per-call sum: 50+30+70 = 150. Output: 8+7+10 = 25. Cache hit: 5+3+7 = 15.
    expect(totals.totalInput).toBe(150);
    expect(totals.totalInputRaw).toBe(150);
    expect(totals.totalOutput).toBe(25);
    expect(totals.totalCacheHit).toBe(15);
    expect(totals.totalCacheCreation).toBe(3);
  });

  it('falls back to last_call when calls[] is missing (single-call turn after plan 445)', () => {
    const cumulative: TokenUsage = {
      input_tokens: 70,
      output_tokens: 10,
      total_tokens: 80,
      cache_hit_tokens: 7,
      cache_creation_tokens: 2,
      // No calls[] — single-call turn
      last_call: { input_tokens: 70, output_tokens: 10, cache_hit_tokens: 7, cache_creation_tokens: 2 },
    };

    const totals = seedTokenUsageFromHistory([msg(cumulative)]);

    expect(totals.totalInput).toBe(70);
    expect(totals.totalOutput).toBe(10);
    expect(totals.totalCacheHit).toBe(7);
    expect(totals.totalCacheCreation).toBe(2);
  });

  it('falls back to legacy top-level fields when neither calls[] nor last_call exists (pre-plan-445 rows)', () => {
    const legacy: TokenUsage = {
      input_tokens: 42,
      output_tokens: 7,
      cache_hit_tokens: 0,
    };

    const totals = seedTokenUsageFromHistory([msg(legacy)]);

    expect(totals.totalInput).toBe(42);
    expect(totals.totalOutput).toBe(7);
    expect(totals.totalCacheHit).toBe(0);
  });

  it('produces non-overlapping totals across multiple turns (the bug plan 546 closes)', () => {
    // Two turns, each with 3 LLM calls. Plan 445 wrote turn-cumulative
    // top-level fields per turn (3-call sums). The OLD seed summed those
    // top-level values, giving 2x the real per-call total. The NEW seed
    // walks calls[], giving exactly the per-call sum — and matches what
    // the `result` handler accumulates during the current turn (so
    // liveTotalInput after seed + this turn's calls = real session total,
    // not 2x real session total).
    const turn1: TokenUsage = {
      input_tokens: 10 + 12 + 14,
      output_tokens: 5 + 6 + 7,
      calls: [call(10, 5), call(12, 6), call(14, 7)],
      last_call: { input_tokens: 14, output_tokens: 7 },
    };
    const turn2: TokenUsage = {
      input_tokens: 20 + 22 + 24,
      output_tokens: 9 + 10 + 11,
      calls: [call(20, 9), call(22, 10), call(24, 11)],
      last_call: { input_tokens: 24, output_tokens: 11 },
    };

    const totals = seedTokenUsageFromHistory([msg(turn1), msg(turn2)]);

    // Per-call sum: (10+12+14) + (20+22+24) = 102. NOT (10+12+14)*2.
    expect(totals.totalInput).toBe(102);
    expect(totals.totalOutput).toBe(5 + 6 + 7 + 9 + 10 + 11);
    expect(totals.totalInputRaw).toBe(102);
  });

  it('skips messages with no tokenUsage (user / tool / system)', () => {
    const cumulative: TokenUsage = {
      input_tokens: 100,
      output_tokens: 10,
      calls: [call(100, 10)],
      last_call: { input_tokens: 100, output_tokens: 10 },
    };
    const totals = seedTokenUsageFromHistory([
      { role: 'user', content: 'hi' } as Message,
      { role: 'tool', content: 'ok', tool_call_id: 't1' } as Message,
      msg(cumulative),
    ]);
    expect(totals.totalInput).toBe(100);
  });

  it('returns zeros for an empty history', () => {
    expect(seedTokenUsageFromHistory([])).toEqual({
      totalInput: 0,
      totalInputRaw: 0,
      totalOutput: 0,
      totalCacheHit: 0,
      totalCacheCreation: 0,
    });
  });

  it('applies the cache-convention guard identical to the result handler', () => {
    // rawInput=0 with cache_hit > rawInput → normalized = rawInput +
    // cacheHit + cacheCreation. This mirrors the live `result` handler
    // so seed + result produce consistent totals.
    const c: TokenUsage = {
      input_tokens: 0,
      output_tokens: 1,
      cache_hit_tokens: 50,
      cache_creation_tokens: 10,
      calls: [call(0, 1, 50, 10)],
      last_call: { input_tokens: 0, output_tokens: 1, cache_hit_tokens: 50, cache_creation_tokens: 10 },
    };

    const totals = seedTokenUsageFromHistory([msg(c)]);

    expect(totals.totalInput).toBe(0 + 50 + 10); // normalized = 60
    expect(totals.totalInputRaw).toBe(0); // raw stays 0
    expect(totals.totalCacheHit).toBe(50);
    expect(totals.totalCacheCreation).toBe(10);
  });
});

describe('deriveSingleCallUsage (plan 546)', () => {
  it('returns last_call when present (plan 445+ rows)', () => {
    const cumulative: TokenUsage = {
      input_tokens: 150, // turn-cumulative — must NOT bleed through
      output_tokens: 25,
      calls: [call(50, 8), call(30, 7), call(70, 10)],
      last_call: { input_tokens: 70, output_tokens: 10, cache_hit_tokens: 7, cache_creation_tokens: 2 },
    };
    expect(deriveSingleCallUsage(cumulative)).toEqual({
      input_tokens: 70,
      output_tokens: 10,
      cache_hit_tokens: 7,
      cache_creation_tokens: 2,
    });
  });

  it('falls back to top-level fields when last_call is missing (legacy rows)', () => {
    const legacy: TokenUsage = { input_tokens: 42, output_tokens: 7, cache_hit_tokens: 0 };
    expect(deriveSingleCallUsage(legacy)).toEqual({
      input_tokens: 42,
      output_tokens: 7,
      cache_hit_tokens: 0,
    });
  });

  it('omits cache fields when neither source carries them', () => {
    const bare: TokenUsage = { input_tokens: 5, output_tokens: 1 };
    const got = deriveSingleCallUsage(bare);
    expect(got).toEqual({ input_tokens: 5, output_tokens: 1 });
    expect(got).not.toHaveProperty('cache_hit_tokens');
    expect(got).not.toHaveProperty('cache_creation_tokens');
  });

  it('returns null for null/undefined cumulative (DuyaAgent legacy-fallback branch handles this)', () => {
    expect(deriveSingleCallUsage(null)).toBeNull();
    expect(deriveSingleCallUsage(undefined)).toBeNull();
  });
});
