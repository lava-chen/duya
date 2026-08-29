// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter is a no-auth model directory that proxies all the
// major Chinese vendors; we strip the upstream prefix and route through
// the provider's direct baseUrl. contextWindow / maxTokens / cost /
// modalities / reasoning flag all come from upstream metadata, which the
// direct endpoints honour identically.
import type { Model } from '../types.js';

export const stepfunModels: Model<'anthropic'>[] = [
  {
    id: 'step-3.7-flash',
    name: "StepFun: Step 3.7 Flash",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 262144,
    maxTokens: 230400,
    cost: {
      input: 0,
      output: 0.000001,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: 'step-3.5-flash',
    name: "StepFun: Step 3.5 Flash",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 262144,
    maxTokens: 65536,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
];
