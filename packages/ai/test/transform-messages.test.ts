import { describe, it, expect } from 'vitest';
import { transformMessages, isSameModel } from '../src/api/transform-messages.js';
import type { Message, Model, ThinkingContent, TextContent } from '../src/types.js';

const targetModel: Model<'anthropic'> = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3',
  api: 'anthropic',
  providerId: 'minimax-anthropic',
  baseUrl: 'https://api.minimaxi.com/anthropic',
  reasoning: true,
  thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  input: ['text', 'image'],
  contextWindow: 200000,
  maxTokens: 8192,
};

describe('isSameModel', () => {
  it('returns true when providerId, model, api all match', () => {
    const msg: Message = {
      role: 'assistant',
      content: [],
      providerId: 'minimax-anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
    };
    expect(isSameModel(msg, targetModel)).toBe(true);
  });

  it('returns false when providerId differs', () => {
    const msg: Message = {
      role: 'assistant',
      content: [],
      providerId: 'minimax-openai',
      model: 'MiniMax-M3',
      api: 'anthropic',
    };
    expect(isSameModel(msg, targetModel)).toBe(false);
  });

  it('returns false when api differs', () => {
    const msg: Message = {
      role: 'assistant',
      content: [],
      providerId: 'minimax-anthropic',
      model: 'MiniMax-M3',
      api: 'openai-chat',
    };
    expect(isSameModel(msg, targetModel)).toBe(false);
  });

  it('returns false when msg has no providerId/model/api', () => {
    const msg: Message = { role: 'assistant', content: [] };
    expect(isSameModel(msg, targetModel)).toBe(false);
  });
});

describe('transformMessages', () => {
  it('keeps thinking block with signature when same model', () => {
    const thinkingBlock: ThinkingContent = {
      type: 'thinking',
      thinking: 'let me think...',
      thinkingSignature: 'sig-abc',
    };
    const msg: Message = {
      role: 'assistant',
      content: [thinkingBlock],
      providerId: 'minimax-anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
    };
    const result = transformMessages([msg], targetModel);
    expect(result[0].content).toEqual([thinkingBlock]);
  });

  it('downgrades thinking to plain text when different model', () => {
    const thinkingBlock: ThinkingContent = {
      type: 'thinking',
      thinking: 'let me think...',
      thinkingSignature: 'sig-abc',
    };
    const msg: Message = {
      role: 'assistant',
      content: [thinkingBlock],
      providerId: 'deepseek',
      model: 'deepseek-r1',
      api: 'openai-chat',
    };
    const result = transformMessages([msg], targetModel);
    const block = result[0].content[0] as TextContent;
    expect(block.type).toBe('text');
    expect(block.text).toBe('let me think...');
    expect(block.textSignature).toBeUndefined();
  });

  it('passes through non-assistant messages unchanged', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    const result = transformMessages([msg], targetModel);
    expect(result[0]).toEqual(msg);
  });

  it('passes through text and tool_use blocks unchanged', () => {
    const textBlock: TextContent = { type: 'text', text: 'answer' };
    const msg: Message = {
      role: 'assistant',
      content: [textBlock, { type: 'tool_use', id: 't1', name: 'foo', input: {} }],
      providerId: 'minimax-anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
    };
    const result = transformMessages([msg], targetModel);
    expect(result[0].content).toEqual(msg.content);
  });
});
