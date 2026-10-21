import { describe, it, expect } from 'vitest';
import { normalizeUsage, calculateCacheHitRate } from '../src/utils/usage.js';

describe('normalizeUsage', () => {
  it('normalizes anthropic-style usage', () => {
    const u = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
    expect(u.input).toBe(10);
    expect(u.output).toBe(5);
    expect(u.cacheRead).toBe(2);
    expect(u.cacheWrite).toBe(1);
  });
  it('subtracts cached tokens from openai prompt totals', () => {
    const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } });
    expect(u.input).toBe(70);
    expect(u.cacheRead).toBe(30);
  });
  it('reports zero for empty', () => {
    expect(normalizeUsage(null)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });
});

describe('calculateCacheHitRate', () => {
  it('computes hit rate', () => {
    expect(calculateCacheHitRate({ input: 70, output: 4, cacheRead: 30, cacheWrite: 0, total: 104 })).toBeCloseTo(0.3);
  });
});