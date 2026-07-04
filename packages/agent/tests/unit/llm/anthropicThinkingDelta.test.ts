import { describe, expect, it } from 'vitest';
import {
  extractAnthropicThinkingDelta,
  getMiniMaxAnthropicMaxTokens,
} from '../../../src/llm/anthropic-client.js';

describe('extractAnthropicThinkingDelta', () => {
  it('reads Anthropic thinking_delta payloads', () => {
    expect(extractAnthropicThinkingDelta({
      type: 'thinking_delta',
      thinking: 'step 1',
    })).toBe('step 1');
  });

  it('reads MiniMax and third-party reasoning fields', () => {
    expect(extractAnthropicThinkingDelta({
      type: 'reasoning_delta',
      reasoning_content: 'reason A',
    })).toBe('reason A');
    expect(extractAnthropicThinkingDelta({
      type: 'thinking_delta',
      reasoning: 'reason B',
    })).toBe('reason B');
  });

  it('returns an empty string for missing payload fields', () => {
    expect(extractAnthropicThinkingDelta({ type: 'thinking_delta' })).toBe('');
  });
});

describe('getMiniMaxAnthropicMaxTokens', () => {
  it('uses the configured max_tokens override when available', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M3', 123456)).toBe(123456);
  });

  it('falls back to MiniMax published max_tokens ceilings', () => {
    // MiniMax-M3: total context = 1,000,000 but max_tokens (output) ceiling = 524,288.
    // The Anthropic-compatible endpoint rejects max_tokens > 524288.
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M3')).toBe(524288);
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M2.7')).toBe(204800);
  });
});
