/**
 * Redacted-thinking replay tests.
 *
 * When Anthropic redacts reasoning mid tool-loop, the encrypted payload must
 * survive the whole chain (duya block → transformMessages → wire block) or
 * the next request's assistant turn loses its thinking prefix and
 * thinking-mode continuations are rejected. Before the fix the payload was
 * never captured and every downstream boundary dropped the block.
 */

import { describe, it, expect } from 'vitest';
import { transformMessages } from '../src/api/transform-messages.js';
import { handleThinkingBlocks, toAnthropicMessages } from '../src/api/anthropic-messages.js';
import type { Message, Model } from '../src/types.js';

const anthropicModel: Model<'anthropic'> = {
  id: 'claude-x',
  name: 'claude-x',
  api: 'anthropic',
  providerId: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 8192,
};

const foreignModel: Model = {
  ...anthropicModel,
  id: 'other-model',
  providerId: 'other',
  api: 'openai-chat',
};

function redactedUserTurn(): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'go', timestamp: 1 },
    {
      id: 'a1',
      role: 'assistant',
      providerId: 'anthropic',
      model: 'claude-x',
      api: 'anthropic',
      timestamp: 2,
      content: [
        { type: 'thinking', thinking: '', redacted: true, encrypted: 'enc-payload' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ],
    },
    { id: 't1r', role: 'tool', tool_call_id: 't1', content: 'ok', timestamp: 3 },
  ];
}

describe('transformMessages — redacted blocks', () => {
  it('keeps the redacted block native for the same model', () => {
    const out = transformMessages(redactedUserTurn(), anthropicModel);
    const assistant = out.find((m) => m.role === 'assistant')!;
    const block = (assistant.content as Array<{ type: string; redacted?: boolean }>)[0];
    expect(block.type).toBe('thinking');
    expect(block.redacted).toBe(true);
  });

  it('swaps the redacted block for a placeholder on a foreign model', () => {
    const out = transformMessages(redactedUserTurn(), foreignModel);
    const assistant = out.find((m) => m.role === 'assistant')!;
    const block = (assistant.content as Array<{ type: string; text?: string }>)[0];
    expect(block.type).toBe('text');
    expect(block.text).toBe('[reasoning redacted by provider]');
  });
});

describe('toAnthropicMessages — redacted replay', () => {
  it('replays the encrypted payload as a native redacted_thinking block', () => {
    const wire = toAnthropicMessages(redactedUserTurn(), anthropicModel);
    const assistant = wire.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const blocks = assistant!.content as Array<{ type: string; data?: string; thinking?: string }>;
    const redacted = blocks.find((b) => b.type === 'redacted_thinking');
    expect(redacted).toBeDefined();
    expect(redacted!.data).toBe('enc-payload');
    // No unvalidated empty thinking block may leak alongside it.
    expect(blocks.some((b) => b.type === 'thinking' && !b.thinking)).toBe(false);
  });
});

describe('handleThinkingBlocks — redacted_thinking wire blocks', () => {
  it('keeps redacted_thinking that carries data', () => {
    const wire = toAnthropicMessages(redactedUserTurn(), anthropicModel);
    const kept = handleThinkingBlocks(wire, anthropicModel);
    const assistant = kept.find((m) => m.role === 'assistant')!;
    expect(
      (assistant.content as Array<{ type: string }>).some((b) => b.type === 'redacted_thinking'),
    ).toBe(true);
  });
});
