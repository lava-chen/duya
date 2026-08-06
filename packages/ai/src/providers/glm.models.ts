// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
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

/**
 * GLM coding-plan models via Anthropic-compatible API
 * (catalog protocol 'anthropic').
 */
export const glmAnthropicModels: Model<'anthropic'>[] = [
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    api: 'anthropic',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    api: 'anthropic',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    api: 'anthropic',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  },
];