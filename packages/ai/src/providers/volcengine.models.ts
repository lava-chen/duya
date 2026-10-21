// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const volcengineModels: Model<'anthropic'>[] = [
  {
    id: 'doubao-1.5-pro-32k',
    name: 'Doubao 1.5 Pro 32K',
    api: 'anthropic',
    providerId: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 32000,
    maxTokens: 8192,
  },
  {
    id: 'doubao-1.5-lite-32k',
    name: 'Doubao 1.5 Lite 32K',
    api: 'anthropic',
    providerId: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 32000,
    maxTokens: 8192,
  },
];