// Model data. Sourced from https://models.dev/api.json (public, no key).
//
// api.deepseek.com serves exactly two ids: deepseek-flash (the V4.1 Flash
// line, which replaced the retired deepseek-v4-flash /
// deepseek-v4-flash-vision-exp ids) and deepseek-v4-pro.
//
// Pricing: DeepSeek bills off-peak (default, ~82% of hours) and peak (UTC
// Mon-Fri 01:00-04:00 and 06:00-10:00, 2x off-peak). Model.cost holds a
// single number per field, so the values below are off-peak rates; peak usage
// is 2x.
import type { Model } from '../types.js';

export const deepseekModels: Model<'openai-chat'>[] = [
  {
    id: 'deepseek-flash',
    name: "DeepSeek V4.1 Flash 1017",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    compat: {
      openAIThinkingFormat: 'deepseek-style',
      requiresReasoningContentOnAssistantMessages: true,
    },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 393216,
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-v4-pro',
    name: "DeepSeek V4 Pro",
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    compat: {
      openAIThinkingFormat: 'deepseek-style',
      requiresReasoningContentOnAssistantMessages: true,
    },
    input: ['text'],
    contextWindow: 1048576,
    maxTokens: 393216,
    cost: {
      input: 0.66,
      output: 1.98,
      cacheRead: 0.022,
      cacheWrite: 0,
    },
  },
];
