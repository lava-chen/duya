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
  },
];
