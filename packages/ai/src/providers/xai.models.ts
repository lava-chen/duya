// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const xaiModels: Model<'anthropic'>[] = [
  {
    id: 'grok-4.20-reasoning',
    name: 'Grok 4.20 Reasoning',
    api: 'anthropic',
    providerId: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'grok-4-1-fast-reasoning',
    name: 'Grok 4-1 Fast Reasoning',
    api: 'anthropic',
    providerId: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
];