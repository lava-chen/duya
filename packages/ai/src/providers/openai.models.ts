// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const openAIModels: Model<'openai-chat'>[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-chat',
    providerId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  },
  {
    id: 'o3',
    name: 'OpenAI o3',
    api: 'openai-chat',
    providerId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'openai-standard' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 100000,
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  },
];