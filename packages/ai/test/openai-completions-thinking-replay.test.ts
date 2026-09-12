import { describe, it, expect } from 'vitest';
import { toOpenAIMessages } from '../src/api/openai-completions.js';
import { transformMessages } from '../src/api/transform-messages.js';
import type { Message, MessageContent, Model } from '../src/types.js';

const deepseekModel: Model<'openai-chat'> = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  api: 'openai-chat',
  providerId: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 1048576,
  maxTokens: 384000,
};

function sameModelAssistant(content: MessageContent[]): Message {
  return {
    role: 'assistant',
    content,
    providerId: 'openai',
    model: 'deepseek-flash',
    api: 'openai-chat',
  };
}

function asRecord(message: unknown): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

describe('toOpenAIMessages thinking replay (DeepSeek reasoning_content passback)', () => {
  it('replays same-model reasoning_content thinking on the assistant wire message', () => {
    const history: Message[] = [
      { role: 'user', content: 'Check the file' },
      sameModelAssistant([
        {
          type: 'thinking',
          thinking: 'Let me check the file first...',
          thinkingSignature: 'reasoning_content',
        },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      ]),
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'file body' },
    ];

    const out = toOpenAIMessages(transformMessages(history, deepseekModel));
    const assistant = asRecord(out.find((m) => m.role === 'assistant'));

    expect(assistant.reasoning_content).toBe('Let me check the file first...');
    expect(assistant.content).toBe('Checking.');
    expect(assistant.tool_calls as unknown[]).toHaveLength(1);
  });

  it('joins multiple thinking blocks of the same signature', () => {
    const history: Message[] = [
      sameModelAssistant([
        { type: 'thinking', thinking: 'first', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'mid' },
        { type: 'thinking', thinking: 'second', thinkingSignature: 'reasoning_content' },
      ]),
    ];

    const out = toOpenAIMessages(transformMessages(history, deepseekModel));
    const assistant = asRecord(out[0]);

    expect(assistant.reasoning_content).toBe('first\n\nsecond');
    expect(assistant.content).toBe('mid');
  });

  it('maps reasoning / reasoning_text signatures to their own wire fields', () => {
    const history: Message[] = [
      sameModelAssistant([
        { type: 'thinking', thinking: 'a', thinkingSignature: 'reasoning' },
        { type: 'thinking', thinking: 'b', thinkingSignature: 'reasoning_text' },
      ]),
    ];

    const out = toOpenAIMessages(transformMessages(history, deepseekModel));
    const assistant = asRecord(out[0]);

    expect(assistant.reasoning).toBe('a');
    expect(assistant.reasoning_text).toBe('b');
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it('does not replay think-tag thinking (foreign wire format for that endpoint)', () => {
    const history: Message[] = [
      sameModelAssistant([
        { type: 'thinking', thinking: 'tagged thought', thinkingSignature: 'think-tag' },
        { type: 'text', text: 'answer' },
      ]),
    ];

    const out = toOpenAIMessages(transformMessages(history, deepseekModel));
    const assistant = asRecord(out[0]);

    expect(assistant.reasoning_content).toBeUndefined();
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.reasoning_text).toBeUndefined();
  });

  it('does not replay cross-model thinking (downgraded to text by transformMessages)', () => {
    const foreign: Message = {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'foreign thought',
          thinkingSignature: 'reasoning_content',
        },
        { type: 'text', text: 'answer' },
      ],
      providerId: 'deepseek',
      model: 'deepseek-r1',
      api: 'openai-chat',
    };

    const out = toOpenAIMessages(transformMessages([foreign], deepseekModel));
    const assistant = asRecord(out[0]);

    expect(assistant.reasoning_content).toBeUndefined();
    // The downgraded thinking text still reaches content as plain text
    // (pre-existing transformMessages behavior).
    expect(assistant.content).toBe('foreign thoughtanswer');
  });

  it('passes a no-thinking assistant message through unchanged', () => {
    const out = toOpenAIMessages([{ role: 'assistant', content: 'plain' }]);
    expect(out[0]).toEqual({ role: 'assistant', content: 'plain' });
  });
});
