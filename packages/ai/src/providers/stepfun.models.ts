// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Step Plan catalogue (api.stepfun.ai/step_plan/v1). step-router-v1 is a
// router, not a model, and the audio models are not chat models.
import type { Model } from '../types.js';

export const stepfunModels: Model<'anthropic'>[] = [
  {
    id: 'step-3.5-flash',
    name: "Step 3.5 Flash",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text'],
    contextWindow: 256000,
    maxTokens: 256000,
    cost: {
      input: 0.10461,
      output: 0.31384,
      cacheRead: 0.02092,
      cacheWrite: 0,
    },
  },
  {
    id: 'step-3.5-flash-2603',
    name: "Step 3.5 Flash 2603",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text'],
    contextWindow: 256000,
    maxTokens: 256000,
    cost: {
      input: 0.10461,
      output: 0.31384,
      cacheRead: 0.02092,
      cacheWrite: 0,
    },
  },
  {
    id: 'step-3.7-flash',
    name: "Step 3.7 Flash",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 256000,
    maxTokens: 256000,
    cost: {
      input: 0.20175,
      output: 1.21052,
      cacheRead: 0.04035,
      cacheWrite: 0,
    },
  },
  {
    id: 'step-5-preview',
    name: "Step 5 Preview",
    api: 'anthropic',
    providerId: 'stepfun',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: {
      input: 1.04613,
      output: 2.98895,
      cacheRead: 0.10461,
      cacheWrite: 0,
    },
  },
];
