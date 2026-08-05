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
  },
];