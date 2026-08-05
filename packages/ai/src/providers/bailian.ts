import type { Model } from '../types.js';

export const bailianModels: Model<'anthropic'>[] = [
  {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    api: 'anthropic',
    providerId: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: 'qwen3.5-plus',
    name: 'Qwen 3.5 Plus',
    api: 'anthropic',
    providerId: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 8192,
  },
];