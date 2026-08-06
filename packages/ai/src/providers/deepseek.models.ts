// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const deepseekModels: Model<'openai-chat'>[] = [
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'reasoning-content' },
    input: ['text'],
    contextWindow: 64000,
    maxTokens: 8192,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 64000,
    maxTokens: 8192,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  },
];