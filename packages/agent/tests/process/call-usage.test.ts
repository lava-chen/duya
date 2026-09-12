import { describe, expect, it } from 'vitest';
import { parseUsageCall } from '../../src/process/call-usage.js';

describe('parseUsageCall', () => {
  it('parses a canonical Anthropic-style usage block', () => {
    const call = parseUsageCall({
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 600,
      total_tokens: 1800,
    });
    expect(call).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      cache_hit_tokens: 600,
      cache_creation_tokens: 400,
      reasoning_tokens: 0,
      cache_write_1h_tokens: 0,
      total_tokens: 1800,
    });
  });

  it('falls back to OpenAI-compatible aliases when cache fields differ', () => {
    const call = parseUsageCall({
      input_tokens: 500,
      output_tokens: 100,
      cache_hit_tokens: 300,
      cache_creation_tokens: 200,
      total_tokens: 900,
    });
    expect(call?.cache_hit_tokens).toBe(300);
    expect(call?.cache_creation_tokens).toBe(200);
  });

  it('resolves reasoning from completion_tokens_details (subset of output)', () => {
    const call = parseUsageCall({
      input_tokens: 10,
      output_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    expect(call?.reasoning_tokens).toBe(30);
    // total_tokens defaults to input + output when absent
    expect(call?.total_tokens).toBe(60);
  });

  it('resolves ephemeral 1h cache write from cache_creation.ephemeral_1h_input_tokens', () => {
    const call = parseUsageCall({
      input_tokens: 10,
      output_tokens: 10,
      cache_creation: { ephemeral_1h_input_tokens: 400 },
    });
    expect(call?.cache_write_1h_tokens).toBe(400);
  });

  it('returns null for an all-zero block (meaningful-usage guard)', () => {
    expect(parseUsageCall({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });

  it('keeps a fully cache-served request meaningful (input=0, hits large)', () => {
    const call = parseUsageCall({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1200,
    });
    expect(call).not.toBeNull();
    expect(call?.cache_hit_tokens).toBe(1200);
  });
});
