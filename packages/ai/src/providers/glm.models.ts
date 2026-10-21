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
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    api: 'openai-chat',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'glm-style' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    api: 'openai-chat',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    compat: { openAIThinkingFormat: 'glm-style' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 131072,
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
    // Same endpoint already ships 131072 on glm-5.3/5.3-flash; the coding-plan
    // Anthropic endpoint accepts the same output ceiling.
    maxTokens: 131072,
    compat: { maxOutputTokens: 131072 },
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
    // Same endpoint already ships 131072 on glm-5.3/5.3-flash; the coding-plan
    // Anthropic endpoint accepts the same output ceiling.
    maxTokens: 131072,
    compat: { maxOutputTokens: 131072 },
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
    // Same endpoint already ships 131072 on glm-5.3/5.3-flash; the coding-plan
    // Anthropic endpoint accepts the same output ceiling.
    maxTokens: 131072,
    compat: { maxOutputTokens: 131072 },
    cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    api: 'anthropic',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    api: 'anthropic',
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 131072,
  },
];