import { describe, expect, it } from 'vitest';
import { resolveWorkerOutputBudget } from '../src/worker-model-output-budget.js';
import type { ProviderRuntimeConfig } from '@duya/ai';

const config = (maxOutputTokens: number): ProviderRuntimeConfig => ({
  providerId: 'custom', providerName: 'Custom', apiFormat: 'anthropic',
  baseUrl: 'http://localhost', model: 'unknown', headers: {}, requestOptions: {},
  modelCapabilities: { maxOutputTokens, contextWindow: 1_000_000 },
});

describe('worker output budget', () => {
  it('uses a generation budget independently from context capacity', () => {
    expect(resolveWorkerOutputBudget({})).toBe(32_768);
    expect(resolveWorkerOutputBudget({ runtimeConfig: config(128_000) })).toBe(32_768);
  });
  it('honors explicit generation budgets and caps them at declared output capacity', () => {
    expect(resolveWorkerOutputBudget({ maxTokens: 64_000, runtimeConfig: config(128_000) })).toBe(64_000);
    expect(resolveWorkerOutputBudget({ maxTokens: 64_000, runtimeConfig: config(8192) })).toBe(8192);
  });
  it('uses compat/catalog limits and ignores invalid numeric overrides', () => {
    const runtimeConfig = { ...config(0), modelCompat: { maxOutputTokens: 2048 } };
    expect(resolveWorkerOutputBudget({ runtimeConfig })).toBe(2048);
    for (const maxTokens of [0, -1, NaN, Infinity]) expect(resolveWorkerOutputBudget({ maxTokens })).toBe(32_768);
    expect(resolveWorkerOutputBudget({ model: 'gpt-4o', maxTokens: 1_000_000 })).toBeLessThan(1_000_000);
  });
});
