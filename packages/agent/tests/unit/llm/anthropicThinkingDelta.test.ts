import { describe, expect, it } from 'vitest';
import { extractAnthropicThinkingDelta } from '../../../src/llm/anthropic-client.js';

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
