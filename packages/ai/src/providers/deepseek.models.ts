// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter is a no-auth model directory that proxies all the
// major Chinese vendors; we strip the upstream prefix and route through
// the provider's direct baseUrl. contextWindow / maxTokens / cost /
// modalities / reasoning flag all come from upstream metadata, which the
// direct endpoints honour identically.
import type { Model } from '../types.js';

export const deepseekModels: Model<'openai-chat'>[] = [
  {
    id: 'deepseek-v4-pro',
    name: "DeepSeek: DeepSeek V4 Pro 0423",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 1048576,
    maxTokens: 384000,
    cost: {
      input: 0.000001,
      output: 0.000002,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-v4-flash',
    name: "DeepSeek: DeepSeek V4 Flash 0423",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 1048576,
    maxTokens: 384000,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-v3.2',
    name: "DeepSeek: DeepSeek V3.2",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 163840,
    maxTokens: 147456,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-r1',
    name: "DeepSeek: R1",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 64000,
    maxTokens: 16000,
    cost: {
      input: 0.000001,
      output: 0.000003,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-chat',
    name: "DeepSeek: DeepSeek V3",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 163840,
    maxTokens: 16000,
    cost: {
      input: 0,
      output: 0.000001,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
];
