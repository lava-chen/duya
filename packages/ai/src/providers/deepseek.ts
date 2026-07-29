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
  },
];
