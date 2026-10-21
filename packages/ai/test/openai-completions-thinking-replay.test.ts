import { describe, it, expect } from 'vitest';
import { toOpenAIMessages, resolveOpenAIThinking, detectOpenAICompatDefaults } from '../src/api/openai-completions.js';
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

describe('empty reasoning_content filler (DeepSeek thinking + tools)', () => {
  it('adds reasoning_content:"" to assistant messages that had no thinking', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      sameModelAssistant([
        { type: 'tool_use', id: 'call_9', name: 'ls', input: {} },
      ]),
      { role: 'tool', tool_call_id: 'call_9', name: 'ls', content: 'ok' },
    ];
    const out = toOpenAIMessages(history, { requiresEmptyReasoningContent: true });
    const assistant = asRecord(out.find((m) => m.role === 'assistant'));
    expect(assistant.reasoning_content).toBe('');
  });

  it('does not overwrite real reasoning_content and stays off by default', () => {
    const history: Message[] = [
      sameModelAssistant([
        { type: 'thinking', thinking: 'real', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'done' },
      ]),
    ];
    const withFiller = toOpenAIMessages(history, { requiresEmptyReasoningContent: true });
    expect(asRecord(withFiller[0]).reasoning_content).toBe('real');

    // Default (no filler): a no-thinking assistant message carries no
    // reasoning_content field at all.
    const plain = toOpenAIMessages([{ role: 'assistant', content: 'plain' }]);
    expect(asRecord(plain[0]).reasoning_content).toBeUndefined();
  });
});

describe('resolveOpenAIThinking format toggles', () => {
  const mk = (compat: Record<string, unknown>): Model<'openai-chat'> => ({
    ...(deepseekModel as unknown as Record<string, unknown>),
    compat,
  } as unknown as Model<'openai-chat'>);

  it('deepseek-style: effort present → thinking enabled', () => {
    const params = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'deepseek-style' }), 'high');
    expect(params).toEqual({ thinking: { type: 'enabled' } });
  });

  it('deepseek-style: effort off → thinking disabled (explicit toggle)', () => {
    const params = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'deepseek-style' }), 'off');
    expect(params).toEqual({ thinking: { type: 'disabled' } });
  });

  it('glm-style: enabled without budget_tokens; off → disabled', () => {
    const on = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'glm-style' }), 'high');
    expect(on).toEqual({ thinking: { type: 'enabled' } });
    const off = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'glm-style' }), 'off');
    expect(off).toEqual({ thinking: { type: 'disabled' } });
  });

  it('qwen-style: off → enable_thinking:false; auto → enabled with budget', () => {
    const off = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'qwen-style' }), 'off');
    expect(off).toEqual({ enable_thinking: false });
    const auto = resolveOpenAIThinking(mk({ openAIThinkingFormat: 'qwen-style' }), undefined);
    expect(auto).toEqual({ enable_thinking: true, thinking_budget: expect.any(Number) });
  });

  it('detects deepseek/qwen/glm defaults from providerId when compat is absent', () => {
    expect(detectOpenAICompatDefaults({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }))
      .toEqual({ openAIThinkingFormat: 'deepseek-style', requiresReasoningContentOnAssistantMessages: true });
    expect(detectOpenAICompatDefaults({ providerId: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }))
      .toEqual({ openAIThinkingFormat: 'qwen-style' });
    expect(detectOpenAICompatDefaults({ providerId: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }))
      .toEqual({ openAIThinkingFormat: 'glm-style' });
    expect(detectOpenAICompatDefaults({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1' }))
      .toEqual({});
  });
});
