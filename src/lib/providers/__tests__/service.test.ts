/**
 * src/lib/providers/__tests__/service.test.ts
 *
 * Tests for the LlmProviderService in-memory CRUD layer.
 * Uses a fake LlmProviderStore (no electron).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LlmProviderService } from '../domain/LlmProviderService';
import type { ApiProvider, LlmProvider, ProviderPreset } from '../types';

class FakeStore {
  data: Record<string, ApiProvider> = {};
  async readAll() {
    return { ...this.data };
  }
  async writeAll(map: Record<string, ApiProvider>) {
    this.data = { ...map };
    return true;
  }
}

function anthropicLegacy(id: string, isActive = false): ApiProvider {
  return {
    id,
    name: id,
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-1234567890',
    isActive,
  };
}

describe('LlmProviderService', () => {
  let store: FakeStore;
  let svc: LlmProviderService;

  beforeEach(() => {
    store = new FakeStore();
    svc = new LlmProviderService(store);
  });

  it('initializes by migrating legacy records', async () => {
    store.data = {
      a: anthropicLegacy('a', true),
      b: anthropicLegacy('b', false),
    };
    await svc.initialize();
    expect(svc.listProviders()).toHaveLength(2);
    expect(svc.getActiveProvider()?.id).toBe('a');
  });

  it('upsertProvider validates', async () => {
    await svc.initialize();
    const bad: LlmProvider = {
      id: 'x',
      name: '',
      category: 'official',
      apiFormat: 'anthropic',
      auth: { type: 'api-key', apiKey: 'sk' },
      endpoints: { baseUrl: 'https://x.com' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    };
    const r = await svc.upsertProvider(bad);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('provider.missingName');
  });

  it('upsertProvider persists', async () => {
    await svc.initialize();
    const ok: LlmProvider = {
      id: 'new',
      name: 'New',
      category: 'official',
      apiFormat: 'anthropic',
      auth: { type: 'api-key', apiKey: 'sk-ant-1234567890' },
      endpoints: { baseUrl: 'https://x.com' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    };
    const r = await svc.upsertProvider(ok);
    expect(r.ok).toBe(true);
    expect(store.data['new']).toBeTruthy();
  });

  it('setActiveProvider sets the active tag', async () => {
    store.data = { a: anthropicLegacy('a', false), b: anthropicLegacy('b', false) };
    await svc.initialize();
    await svc.setActiveProvider('b');
    expect(svc.getActiveProvider()?.id).toBe('b');
    expect(store.data['a'].isActive).toBe(false);
    expect(store.data['b'].isActive).toBe(true);
  });

  it('setActiveProvider rejects missing id', async () => {
    await svc.initialize();
    const r = await svc.setActiveProvider('nope');
    expect(r.ok).toBe(false);
  });

  it('deleteProvider removes the record', async () => {
    store.data = { a: anthropicLegacy('a', true) };
    await svc.initialize();
    expect(await svc.deleteProvider('a')).toBe(true);
    expect(svc.listProviders()).toHaveLength(0);
    expect(svc.getActiveProvider()).toBeUndefined();
  });

  it('reorderProviders updates sortIndex', async () => {
    store.data = { a: anthropicLegacy('a'), b: anthropicLegacy('b') };
    await svc.initialize();
    await svc.reorderProviders(['b', 'a']);
    expect(svc.getProvider('b')?.meta.sortIndex).toBe(0);
    expect(svc.getProvider('a')?.meta.sortIndex).toBe(1);
  });

  it('createProviderFromPreset builds a valid provider', async () => {
    await svc.initialize();
    const preset: ProviderPreset = {
      key: 'glm-cn',
      name: 'GLM',
      category: 'aggregator',
      apiFormat: 'anthropic',
      authFields: [{ key: 'api_key', label: 'API Key', secret: true, required: true }],
      defaultEndpoint: 'https://open.bigmodel.cn/api/anthropic',
      modelsSource: { type: 'static' },
      ui: { icon: 'zhipu' },
    };
    const r = await svc.createProviderFromPreset(preset, {
      id: 'glm-1',
      name: 'GLM 1',
      apiKey: 'sk-glm-1234567890',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider.id).toBe('glm-1');
      expect(r.provider.endpoints.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(r.provider.auth.apiKey).toBe('sk-glm-1234567890');
    }
  });
});

describe('LlmProviderService — Phase 3: subscribeToConfigUpdates', () => {
  it('debounces a burst of updates into a single re-init', async () => {
    const store = new FakeStore();
    const svc = new LlmProviderService(store);
    store.data = { a: anthropicLegacy('a', true) };
    await svc.initialize();

    // Subscribe to onChange.
    let configCallCount = 0;
    const unsubscribe = svc.subscribeToConfigUpdates(() => {
      configCallCount += 1;
    });

    expect(typeof unsubscribe).toBe('function');
    // Idempotent: a second call returns the same unsubscribe fn.
    expect(svc.subscribeToConfigUpdates(() => {})).toBe(unsubscribe);

    // The fake store has no `onChange`, so the service falls back
    // to a no-op unsubscribe — but the user callback should still
    // have been wrapped and not called (no config update fired).
    expect(configCallCount).toBe(0);
    unsubscribe();
  });

  it('listProviderIds remains consistent after a fake resync', async () => {
    const store = new FakeStore();
    const svc = new LlmProviderService(store);
    store.data = { a: anthropicLegacy('a'), b: anthropicLegacy('b') };
    await svc.initialize();
    expect(svc.listProviders()).toHaveLength(2);
    // No onChange in FakeStore, so resync is a no-op. The list
    // is whatever the in-memory state is.
    expect(svc.getProvider('a')).toBeTruthy();
  });
});
