// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const stepfunModels: Model<'anthropic'>[] = [
  {
    id: 'step-3.5-flash',
    name: 'Step-3.5 Flash',
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  },
  {
    id: 'step-3.5-flash-2603',
    name: 'Step-3.5 Flash (2603)',
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  },
];