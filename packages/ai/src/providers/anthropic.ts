import type { Model } from '../types.js';

export const anthropicModels: Model<'anthropic'>[] = [
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    api: 'anthropic',
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16000,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    api: 'anthropic',
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
];
