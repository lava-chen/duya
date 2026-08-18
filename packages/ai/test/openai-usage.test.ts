import { describe, it, expect } from 'vitest';
import { mapOpenAIUsage } from '../src/api/openai-completions.js';
import { mapResponsesUsage } from '../src/api/openai-responses.js';

describe('mapOpenAIUsage (Chat Completions cached_tokens)', () => {
  it('maps prompt/completion tokens and splits out cache hits', () => {
    const u = mapOpenAIUsage(100, 4, 30);
    expect(u).toEqual({ input_tokens: 100, output_tokens: 4, cache_hit_tokens: 30 });
  });

  it('keeps input at the full prompt total (cached tokens are a subset, not added)', () => {
    // OpenAI's prompt_tokens already includes cached_tokens — mapping must not
    // inflate input, otherwise the downstream normalizeInputTokens guard would
    // double count.
    const u = mapOpenAIUsage(100, 4, 30);
    expect(u.input_tokens).toBe(100);
    expect(u.cache_hit_tokens).toBe(30);
  });

  it('handles missing fields as zero', () => {
    expect(mapOpenAIUsage(undefined, undefined, undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_hit_tokens: 0,
    });
    expect(mapOpenAIUsage(100, 4, undefined)).toEqual({
      input_tokens: 100,
      output_tokens: 4,
      cache_hit_tokens: 0,
    });
  });
});

describe('mapResponsesUsage (Responses API cached_tokens)', () => {
  it('maps input/output/total tokens and splits out cache hits', () => {
    const u = mapResponsesUsage(100, 4, 104, 30);
    expect(u).toEqual({
      input_tokens: 100,
      output_tokens: 4,
      total_tokens: 104,
      cache_hit_tokens: 30,
    });
  });

  it('keeps input at the full total (cached tokens are a subset)', () => {
    const u = mapResponsesUsage(100, 4, 104, 30);
    expect(u.input_tokens).toBe(100);
    expect(u.cache_hit_tokens).toBe(30);
  });

  it('handles missing fields as zero', () => {
    expect(mapResponsesUsage(undefined, undefined, undefined, undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: undefined,
      cache_hit_tokens: 0,
    });
  });
});
