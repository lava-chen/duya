import type { Model } from '../types.js';

export const glmModels: Model<'openai-chat'>[] = [
  {
    id: 'glm-4-plus',
    name: 'GLM-4 Plus',
    api: 'openai-chat',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'glm-style' },
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 4096,
  },
];
