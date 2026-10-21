// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter is a no-auth model directory that proxies all the
// major Chinese vendors; we strip the upstream prefix and route through
// the provider's direct baseUrl. contextWindow / maxTokens / cost /
// modalities / reasoning flag all come from upstream metadata, which the
// direct endpoints honour identically.
import type { Model } from '../types.js';

// api.deepseek.com currently serves exactly two models. The V4.1 Flash line
// replaced the retired deepseek-v4-flash / deepseek-v4-flash-vision-exp ids and
// is exposed as `deepseek-flash`; deepseek-v4-pro remains valid but is being
// routed to V4.1 Flash from 2026-09-14. Refresh with:
//   npm run sync:models -w @duya/ai -- --only=deepseek
//
// Pricing: DeepSeek bills off-peak (default, ~82% of hours) and peak (UTC
// Mon-Fri 01:00-04:00 and 06:00-10:00, 2x off-peak). Model.cost only holds a
// single number per field, so the values below are off-peak rates (the most
// representative single number); peak usage will be 2x. Values are kept at
// natural precision - do not round to 6 decimals, that zeros out the
// input/cacheRead fields for these models.
export const deepseekModels: Model<'openai-chat'>[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    api: 'openai-chat',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    // DeepSeek V4.1 hybrid thinking: explicit enabled/disabled toggle, and
    // every assistant history message must carry reasoning_content (empty
    // string when the turn had none) when tools are present.
    compat: {
      openAIThinkingFormat: 'deepseek-style',
      requiresReasoningContentOnAssistantMessages: true,
    },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 384000,
    cost: {
      input: 0.00000015,
      output: 0.0000006,
      cacheRead: 0.000000003,
      cacheWrite: 0,
    },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek: DeepSeek V4 Pro 0813',
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
    maxTokens: 384000,
    cost: {
      input: 0.00000066,
      output: 0.00000198,
      cacheRead: 0.000000022,
      cacheWrite: 0,
    },
  },
];
