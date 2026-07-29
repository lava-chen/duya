import { describe, it, expect } from 'vitest';
import { getSupportedThinkingLevels, clampThinkingLevel, getNativeLevel } from '../src/models.js';
import type { Model } from '../src/types.js';

const minimaxAnthropicM3: Model<'anthropic'> = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3 (Anthropic)',
  api: 'anthropic',
  providerId: 'minimax-anthropic',
  baseUrl: 'https://api.minimaxi.com/anthropic',
  reasoning: true,
  thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  input: ['text', 'image'],
  contextWindow: 200000,
  maxTokens: 8192,
  compat: { forceAdaptiveThinking: true },
};

const gpt4o: Model<'openai-chat'> = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  api: 'openai-chat',
  providerId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text', 'image'],
  contextWindow: 128000,
  maxTokens: 4096,
};

describe('getSupportedThinkingLevels', () => {
  it('returns empty array for non-reasoning model', () => {
    expect(getSupportedThinkingLevels(gpt4o)).toEqual([]);
  });

  it('excludes off when thinkingLevelMap.off === null', () => {
    const levels = getSupportedThinkingLevels(minimaxAnthropicM3);
    expect(levels).not.toContain('off');
    expect(levels).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('includes off when thinkingLevelMap.off is a string', () => {
    const model: Model = { ...minimaxAnthropicM3, thinkingLevelMap: { off: 'off', low: 'low', high: 'high' } };
    const levels = getSupportedThinkingLevels(model);
    expect(levels).toContain('off');
    expect(levels).toContain('low');
    expect(levels).toContain('high');
  });

  it('returns default levels when thinkingLevelMap is undefined', () => {
    const model: Model = { ...minimaxAnthropicM3, thinkingLevelMap: undefined };
    const levels = getSupportedThinkingLevels(model);
    expect(levels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('clampThinkingLevel', () => {
  it('returns undefined for non-reasoning model', () => {
    expect(clampThinkingLevel(gpt4o, 'high')).toBeUndefined();
  });

  it('returns undefined when level is off or undefined', () => {
    expect(clampThinkingLevel(minimaxAnthropicM3, undefined)).toBeUndefined();
    expect(clampThinkingLevel(minimaxAnthropicM3, 'off' as any)).toBeUndefined();
  });

  it('clamps xhigh to max when xhigh is not supported', () => {
    expect(clampThinkingLevel(minimaxAnthropicM3, 'xhigh')).toBe('max');
  });

  it('returns the level when it is directly supported', () => {
    expect(clampThinkingLevel(minimaxAnthropicM3, 'low')).toBe('low');
    expect(clampThinkingLevel(minimaxAnthropicM3, 'max')).toBe('max');
  });

  it('clamps down to nearest supported level', () => {
    const model: Model = {
      ...minimaxAnthropicM3,
      thinkingLevelMap: { off: null, low: 'low', high: 'high' },
    };
    expect(clampThinkingLevel(model, 'medium')).toBe('low');
    expect(clampThinkingLevel(model, 'max')).toBe('high');
  });
});

describe('getNativeLevel', () => {
  it('returns the level itself when thinkingLevelMap is undefined', () => {
    const model: Model = { ...minimaxAnthropicM3, thinkingLevelMap: undefined };
    expect(getNativeLevel(model, 'high')).toBe('high');
  });

  it('returns mapped string when level is in map', () => {
    expect(getNativeLevel(minimaxAnthropicM3, 'high')).toBe('high');
    expect(getNativeLevel(minimaxAnthropicM3, 'max')).toBe('max');
  });

  it('returns undefined when level maps to null', () => {
    expect(getNativeLevel(minimaxAnthropicM3, 'off')).toBeUndefined();
  });

  it('returns undefined when level is not in map', () => {
    expect(getNativeLevel(minimaxAnthropicM3, 'xhigh' as any)).toBeUndefined();
  });
});
