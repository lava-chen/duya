import { describe, it, expect } from 'vitest';
import {
  normalizeInputTokens,
  estimateCost,
  formatTokensPi,
} from './context-usage-utils';

describe('normalizeInputTokens (cache-convention guard)', () => {
  it('keeps input unchanged when cache hits are within input (Anthropic: input includes cache)', () => {
    // Anthropic reports input_tokens including cache-read tokens.
    expect(normalizeInputTokens(1000, 800)).toBe(1000);
    expect(normalizeInputTokens(1000, 0)).toBe(1000);
    expect(normalizeInputTokens(1000, 1000)).toBe(1000);
  });

  it('adds cache hits back when hits exceed input (OpenAI-compatible gateway: input excludes cache)', () => {
    // Gateway reports only the uncached delta; cache hits are separate and
    // larger than the reported input.
    expect(normalizeInputTokens(128, 3000)).toBe(3128);
    expect(normalizeInputTokens(0, 3000)).toBe(3000);
    expect(normalizeInputTokens(500, 2000)).toBe(2500);
  });

  it('handles missing fields as zero', () => {
    expect(normalizeInputTokens(undefined as unknown as number, undefined as unknown as number)).toBe(0);
    expect(normalizeInputTokens(1000, undefined as unknown as number)).toBe(1000);
    expect(normalizeInputTokens(undefined as unknown as number, 500)).toBe(500);
  });

  it('does not double-count on cache boundary equality', () => {
    expect(normalizeInputTokens(3000, 3000)).toBe(3000);
  });

  it('adds cache write back on the first request of a session (cacheRead still 0)', () => {
    // Anthropic's first request: input_tokens excludes the full prefix that
    // was just written to cache (system + tools, often tens of thousands).
    expect(normalizeInputTokens(1200, 0, 50000)).toBe(51200);
    expect(normalizeInputTokens(0, 0, 50000)).toBe(50000);
    expect(normalizeInputTokens(1200, 300, 50000)).toBe(51500);
  });

  it('adds both cache read and cache write when both exceed input', () => {
    expect(normalizeInputTokens(128, 3000, 2000)).toBe(5128);
    expect(normalizeInputTokens(0, 3000, 2000)).toBe(5000);
  });

  it('keeps input unchanged when cache write is within input (input already includes cache)', () => {
    expect(normalizeInputTokens(50000, 0, 40000)).toBe(50000);
    expect(normalizeInputTokens(1000, 800, 0)).toBe(1000);
    expect(normalizeInputTokens(1000, 0, 0)).toBe(1000);
  });

  it('returns 0 for all-zeros (no-op request)', () => {
    expect(normalizeInputTokens(0, 0, 0)).toBe(0);
  });
});

describe('formatTokensPi (pi-style compact formatting)', () => {
  it('formats below 1k as integers', () => {
    expect(formatTokensPi(0)).toBe('0');
    expect(formatTokensPi(999)).toBe('999');
  });

  it('formats 1k..10k with one decimal', () => {
    expect(formatTokensPi(1000)).toBe('1.0k');
    expect(formatTokensPi(93000)).toBe('93k');
    expect(formatTokensPi(61000)).toBe('61k');
  });

  it('formats 10k..1M as integer k', () => {
    expect(formatTokensPi(10000)).toBe('10k');
    expect(formatTokensPi(999000)).toBe('999k');
  });

  it('formats 1M..10M with one decimal, above as integer M', () => {
    expect(formatTokensPi(1000000)).toBe('1.0M');
    expect(formatTokensPi(10000000)).toBe('10M');
    expect(formatTokensPi(9300000)).toBe('9.3M');
  });
});

describe('estimateCost', () => {
  it('computes Claude-style cost from rates', () => {
    // input $2.5/M, output $10/M, cache read $0.625/M, cache write $1.25/M
    // estimateCost itself does NOT call normalizeInputTokens — the caller is
    // responsible for passing the already-normalized totalInput. Here totalInput
    // is 1M (already post-normalize), with 100k output and 2M cache reads.
    // cost = 2.5*1 + 10*0.1 + 0.625*2 + 1.25*0 = 2.5+1.0+1.25 = 4.75
    const cost = estimateCost(1000000, 100000, 2000000, 0, {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.625,
      cacheWritePerMillion: 1.25,
    });
    expect(cost).toBeCloseTo(4.75, 6);
  });

  it('returns 0 for no usage', () => {
    expect(estimateCost(0, 0, 0, 0)).toBe(0);
  });
});
