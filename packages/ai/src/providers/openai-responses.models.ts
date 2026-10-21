// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const openaiResponsesModels: Model<'openai-responses'>[] = [
  {
    id: 'o1',
    name: 'OpenAI o1',
    api: 'openai-responses',
    providerId: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 100000,
    compat: {
      openAIThinkingFormat: 'reasoning-content',
      fixedTemperature: 1,
    },
  },
  {
    id: 'o3',
    name: 'OpenAI o3',
    api: 'openai-responses',
    providerId: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 100000,
    compat: {
      openAIThinkingFormat: 'reasoning-content',
      fixedTemperature: 1,
    },
  },
  {
    id: 'o4-mini',
    name: 'OpenAI o4-mini',
    api: 'openai-responses',
    providerId: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 100000,
    compat: {
      openAIThinkingFormat: 'reasoning-content',
      fixedTemperature: 1,
    },
  },
];