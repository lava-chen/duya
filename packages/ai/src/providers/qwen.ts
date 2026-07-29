import type { Model } from '../types.js';

export const qwenModels: Model<'openai-chat'>[] = [
  {
    id: 'qwq-32b-preview',
    name: 'QwQ 32B Preview',
    api: 'openai-chat',
    providerId: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'qwen-style' },
    input: ['text'],
    contextWindow: 131072,
    maxTokens: 8192,
  },
];
