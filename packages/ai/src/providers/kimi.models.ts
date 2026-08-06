// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const kimiModels: Model<'openai-chat'>[] = [
  {
    id: 'moonshot-v1-auto',
    name: 'Moonshot v1 Auto',
    api: 'openai-chat',
    providerId: 'kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 8192,
  },
];