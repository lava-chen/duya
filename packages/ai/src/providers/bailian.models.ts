// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter proxies the Qwen family with the same contextWindow /
// maxTokens / modalities / reasoning flag that the direct dashscope
// Anthropic-compat endpoint (`coding.dashscope.aliyuncs.com/apps/anthropic`)
// advertises, so the static list here matches what users actually get.
import type { Model } from '../types.js';

export const bailianModels: Model<'anthropic'>[] = [
  {
    id: 'qwen3.8-max',
    name: 'Qwen 3.8 Max',
    api: 'anthropic',
    providerId: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 131072,
    cost: {
      input: 0.000002,
      output: 0.000006,
      cacheRead: 0.00000025,
      cacheWrite: 0.0000025,
    },
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    api: 'anthropic',
    providerId: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 131072,
    cost: {
      input: 0.00000032,
      output: 0.00000128,
      cacheRead: 0.000000064,
      cacheWrite: 0.0000004,
    },
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    api: 'anthropic',
    providerId: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
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
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: {
      input: 0.0000003,
      output: 0.0000018,
      cacheRead: 0,
      cacheWrite: 0.000000375,
    },
  },
];