/**
 * electron/automation/__tests__/provider-resolve.test.ts
 *
 * Provider/model resolution for cron + bot wake runs (resolveCronProvider /
 * resolveBotWakeProvider). The provider-store binding is mocked out so this
 * stays a fast node-only unit test — resolution itself ships a fake reader
 * with a no-op DAO (see provider-store.ts docstring/pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmProvider } from '../../../src/lib/providers/types';
import { resolveCronProvider, resolveBotWakeProvider } from '../provider';
import type { ProviderStore } from '../../services/providers/provider-store';

// Shared mutable store so getProviderStore() and the test bodies agree on the
// same singleton (AGENTS pattern: mock state lives inside vi.hoisted).
const mocks = vi.hoisted(() => {
  const makeProvider = (
    id: string,
    model: string,
    opts?: Partial<LlmProvider>,
  ): LlmProvider => ({
    id,
    name: id,
    category: 'official',
    apiFormat: 'openai-chat',
    auth: { type: 'api-key', apiKey: 'sk-test' } as LlmProvider['auth'],
    endpoints: { baseUrl: 'https://api.test.example/v1' },
    ui: { name: id, color: '', icon: 'bot' } as LlmProvider['ui'],
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 1, tags: [] },
    options: { model },
    ...opts,
  });

  const providers: LlmProvider[] = [
    makeProvider('default-provider', 'gpt-default'),
    makeProvider('claude-provider', 'claude-sonnet'),
  ];

  const store = {
    getLlmProvider: (id: string) => providers.find((p) => p.id === id),
    getDefaultLlmProvider: () => providers[0],
    listLlmProviders: () => [...providers],
  } as unknown as ProviderStore;

  return { store, providers };
});

vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => mocks.store,
}));

describe('provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolveCronProvider uses the default provider + its default model', () => {
    const r = resolveCronProvider(undefined);
    expect(r.provider.id).toBe('default-provider');
    expect(r.model).toBe('gpt-default');
  });

  it('resolveCronProvider honors an explicit cron model', () => {
    const r = resolveCronProvider('gpt-4o');
    expect(r.model).toBe('gpt-4o');
  });

  it('resolveBotWakeProvider uses the bot provider id + model from config', () => {
    const r = resolveBotWakeProvider('claude-provider', 'claude-sonnet');
    expect(r.provider.id).toBe('claude-provider');
    expect(r.model).toBe('claude-sonnet');
  });

  it('resolveBotWakeProvider falls back to the default provider when the bot has no override', () => {
    const r = resolveBotWakeProvider(undefined);
    expect(r.provider.id).toBe('default-provider');
    expect(r.model).toBe('gpt-default');
  });

  it('resolveBotWakeProvider falls back to the default provider for an unknown provider id', () => {
    const r = resolveBotWakeProvider('missing-provider', 'gpt-4o');
    expect(r.provider.id).toBe('default-provider');
    expect(r.model).toBe('gpt-4o');
  });
});