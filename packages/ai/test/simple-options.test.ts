import { describe, it, expect } from 'vitest';
import { shouldDisableThinking, getMaxOutputTokens, getTemperature } from '../src/utils/simple-options.js';
import type { Model } from '../src/types.js';

const baseModel: Model<'openai-chat'> = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-chat',
  providerId: 'test',
  baseUrl: 'https://api.test.com/v1',
  reasoning: true,
  thinkingLevelMap: { off: null, low: 'low', high: 'high' },
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 4096,
};

describe('shouldDisableThinking', () => {
  it('returns true for non-reasoning model', () => {
    const model: Model = { ...baseModel, reasoning: false };
    expect(shouldDisableThinking(model)).toBe(true);
  });

  it('returns false for reasoning model', () => {
    expect(shouldDisableThinking(baseModel)).toBe(false);
  });
});

describe('getMaxOutputTokens', () => {
  it('returns model.maxTokens when userMax is undefined', () => {
    expect(getMaxOutputTokens(baseModel)).toBe(4096);
  });

  it('returns userMax when it is less than model.maxTokens', () => {
    expect(getMaxOutputTokens(baseModel, 2048)).toBe(2048);
  });

  it('caps userMax at model.maxTokens', () => {
    expect(getMaxOutputTokens(baseModel, 99999)).toBe(4096);
  });

  it('returns model.maxTokens when userMax is 0 or negative', () => {
    expect(getMaxOutputTokens(baseModel, 0)).toBe(4096);
    expect(getMaxOutputTokens(baseModel, -1)).toBe(4096);
  });
});

describe('getTemperature', () => {
  it('returns userTemp when model has no fixedTemperature', () => {
    expect(getTemperature(baseModel, 0.7)).toBe(0.7);
  });

  it('returns fixedTemperature when model has one set', () => {
    const model: Model = { ...baseModel, compat: { fixedTemperature: 0.5 } };
    expect(getTemperature(model, 0.7)).toBe(0.5);
  });

  it('returns undefined when neither userTemp nor fixedTemperature is set', () => {
    expect(getTemperature(baseModel)).toBeUndefined();
  });

  it('returns fixedTemperature even when userTemp is undefined', () => {
    const model: Model = { ...baseModel, compat: { fixedTemperature: 0.3 } };
    expect(getTemperature(model)).toBe(0.3);
  });
});
