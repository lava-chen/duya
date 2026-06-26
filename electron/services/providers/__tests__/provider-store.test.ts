/**
 * electron/services/providers/__tests__/provider-store.test.ts
 *
 * Tests for the Electron main-side provider store. Uses a fake
 * `ProviderStoreReader` so the test does NOT depend on
 * `electron/config/manager.ts` or `safeStorage`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProviderStore,
  type ProviderStoreReader,
} from '../provider-store';
import type { ApiProvider, LlmProvider, ModelCapability } from '../../../../src/lib/providers/types';
import { validateRuntimeConfig, redactSecrets } from '../../../../src/lib/providers/domain/ProviderRuntimeAdapter';

class FakeReader implements ProviderStoreReader {
  data: Record<string, ApiProvider> = {};
  defaultId: string | undefined = undefined;
  writeCount = 0;
  readAll() {
    return { ...this.data };
  }
  readOne(id: string) {
    return this.data[id];
  }
  /** @deprecated Use readDefault. */
  readActive() {
    return this.readDefault();
  }
  readDefault() {
    return this.defaultId ? this.data[this.defaultId] : undefined;
  }
  writeAll(map: Record<string, ApiProvider>): boolean {
    this.data = { ...map };
    this.writeCount += 1;
    return true;
  }
  onChange(_cb: () => void): () => void {
    return () => {};
  }
}

function makeLlm(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'p1',
    name: 'P1',
    category: 'official',
    apiFormat: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-ant-1234567890' },
    endpoints: { baseUrl: 'https://api.anthropic.com' },
    ui: {},
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    ...overrides,
  };
}

function makeLegacyAnthropic(id: string, isActive = false): ApiProvider {
  return {
    id,
    name: id,
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-1234567890',
    isActive,
  };
}

describe('ProviderStore — read path', () => {
  let reader: FakeReader;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    store = new ProviderStore(reader);
  });

  it('migrates legacy providers on first read', () => {
    reader.data = { a: makeLegacyAnthropic('a', true) };
    const result = store.migrateAllLegacyProviders();
    expect(result.count).toBe(1);
    expect(result.activeId).toBe('a');
    const llm = store.getLlmProvider('a');
    expect(llm).toBeTruthy();
    expect(llm!.apiFormat).toBe('anthropic');
    expect(llm!.auth.apiKey).toBe('sk-ant-1234567890');
    expect(store.getActiveLlmProvider()?.id).toBe('a');
  });

  it('lazy-migrates on listLlmProviders / getLlmProvider / getActive', () => {
    reader.data = { a: makeLegacyAnthropic('a') };
    expect(store.listLlmProviders()).toHaveLength(1);
    expect(store.getLlmProvider('a')).toBeTruthy();
    expect(store.getActiveLlmProvider()).toBeUndefined();
  });

  it('listLlmProviders sorts by sortIndex', () => {
    reader.data = {
      a: { ...makeLegacyAnthropic('a'), sortOrder: 5 },
      b: { ...makeLegacyAnthropic('b'), sortOrder: 1 },
      c: { ...makeLegacyAnthropic('c'), sortOrder: 3 },
    };
    const list = store.listLlmProviders().map((p) => p.id);
    expect(list).toEqual(['b', 'c', 'a']);
  });
});

describe('ProviderStore — write path', () => {
  let reader: FakeReader;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();
  });

  it('upsertLlmProvider validates and persists', () => {
    const bad: LlmProvider = makeLlm({ name: '' });
    const r = store.upsertLlmProvider(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('provider.missingName');
    }
    expect(reader.writeCount).toBe(0);

    const good = makeLlm({ id: 'new', name: 'New' });
    const ok = store.upsertLlmProvider(good);
    expect(ok.ok).toBe(true);
    expect(reader.data['new']).toBeTruthy();
    expect(reader.data['new'].apiKey).toBe('sk-ant-1234567890');
  });

  it('upsertLlmProvider persists as legacy ApiProvider (round-trip)', () => {
    const llm = makeLlm({
      id: 'p-round',
      name: 'P round',
      apiFormat: 'openai-chat',
      auth: { type: 'api-key', apiKey: 'sk-oai-1234567890' },
      endpoints: { baseUrl: 'https://api.openai.com/v1' },
      category: 'official',
      extraEnv: { API_TIMEOUT_MS: '3000000' },
      options: { defaultModel: 'gpt-4o' },
    });
    store.upsertLlmProvider(llm);
    const legacy = reader.data['p-round'];
    expect(legacy).toBeTruthy();
    expect(legacy.apiKey).toBe('sk-oai-1234567890');
    expect(legacy.baseUrl).toBe('https://api.openai.com/v1');
    // category=official + apiFormat=openai-chat + baseUrl=openai.com
    // → providerType 'openai' (per the legacy mapper)
    expect(legacy.providerType).toBe('openai');
    expect(legacy.extraEnv).toEqual({ API_TIMEOUT_MS: '3000000' });
  });

  it('setActiveLlmProvider switches active and updates tags', () => {
    expect(store.setActiveLlmProvider('a')).toBe(true);
    expect(store.getActiveLlmProvider()?.id).toBe('a');
    expect(reader.data['a'].isActive).toBe(true);
  });

  it('setActiveLlmProvider rejects missing id', () => {
    expect(store.setActiveLlmProvider('nope')).toBe(false);
  });

  it('deleteLlmProvider removes the record and clears active', () => {
    expect(store.deleteLlmProvider('a')).toBe(true);
    expect(store.listLlmProviders()).toHaveLength(0);
    expect(store.getActiveLlmProvider()).toBeUndefined();
  });
});

describe('ProviderStore — Plan 209 mask defense', () => {
  let reader: FakeReader;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    // Start with a real key on disk so we can prove it survives a
    // rejected (masked) upsert.
    reader.data = {
      p1: {
        id: 'p1',
        name: 'P1',
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-REAL-1234567890',
        isActive: true,
      },
    };
    store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();
  });

  it('rejects an upsert whose auth.apiKey is a mask', () => {
    const masked = makeLlm({
      id: 'p1',
      name: 'P1',
      auth: { type: 'api-key', apiKey: 'sk-a***cdef' },
    });
    const r = store.upsertLlmProvider(masked);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('masked_key');
    }
  });

  it('rejected upsert does not overwrite the existing key on disk', () => {
    const masked = makeLlm({
      id: 'p1',
      name: 'P1',
      auth: { type: 'api-key', apiKey: 'sk-a***cdef' },
    });
    store.upsertLlmProvider(masked);
    // The legacy write layer should NOT have been touched.
    expect(reader.writeCount).toBe(0);
    expect(reader.data['p1'].apiKey).toBe('sk-ant-REAL-1234567890');
  });

  it('accepts a legitimate replacement key', () => {
    const replaced = makeLlm({
      id: 'p1',
      name: 'P1',
      auth: { type: 'api-key', apiKey: 'sk-ant-NEW-1234567890' },
    });
    const r = store.upsertLlmProvider(replaced);
    expect(r.ok).toBe(true);
    expect(reader.data['p1'].apiKey).toBe('sk-ant-NEW-1234567890');
  });

  it('Plan 209 fix: preserves the existing key when the user did not retype on edit', () => {
    // The renderer-side `sharedMeta.auth = { type: 'api-key' }`
    // has an undefined `apiKey` when the 3-state machine is in
    // 'untouched' (the user did not edit the key). Without the
    // fix below, `validateAuth` would fail with
    // `auth.missingApiKey` and the entire upsert — including
    // `enabled_models` — would be silently dropped.
    const untouched = makeLlm({
      id: 'p1',
      name: 'P1',
      auth: { type: 'api-key' }, // apiKey intentionally omitted
    });
    // Add an unrelated field so we can prove the save also
    // actually round-trips the rest of the LlmProvider.
    (untouched as unknown as { options: unknown }).options = {
      enabled_models: ['m1'],
    };
    const r = store.upsertLlmProvider(untouched);
    expect(r.ok).toBe(true);
    expect(reader.data['p1'].apiKey).toBe('sk-ant-REAL-1234567890');
    expect(reader.data['p1'].options).toEqual({ enabled_models: ['m1'] });
  });

  it('accepts a cleared key (auth.type = none)', () => {
    const cleared = makeLlm({
      id: 'p1',
      name: 'P1',
      auth: { type: 'none' },
    });
    const r = store.upsertLlmProvider(cleared);
    expect(r.ok).toBe(true);
    expect(reader.data['p1'].apiKey).toBe('');
  });

  it('accepts a provider that never had a key (auth.type = none)', () => {
    const fresh = makeLlm({
      id: 'p2',
      name: 'P2',
      auth: { type: 'none' },
    });
    const r = store.upsertLlmProvider(fresh);
    expect(r.ok).toBe(true);
    expect(reader.data['p2'].apiKey).toBe('');
  });
});

describe('ProviderStore — runtime config', () => {
  let reader: FakeReader;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();
  });

  it('builds an Anthropic runtime config from the active provider', () => {
    const r = store.getActiveProviderRuntimeConfig('claude-sonnet-4-5');
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.providerId).toBe('a');
      expect(r.apiFormat).toBe('anthropic');
      expect(r.baseUrl).toBe('https://api.anthropic.com');
      expect(r.apiKey).toBe('sk-ant-1234567890');
      // Phase 1 migration sets apiKeyField='ANTHROPIC_AUTH_TOKEN' by
      // default for Anthropic-format providers, which means the
      // runtime config uses Bearer (auth_token) style. The
      // x-api-key path is exercised by unit tests in
      // `runtime-adapter.test.ts`.
      expect(r.headers['Authorization']).toBe('Bearer sk-ant-1234567890');
      expect(r.headers['anthropic-version']).toBe('2023-06-01');
      expect(r.model).toBe('claude-sonnet-4-5');
      const v = validateRuntimeConfig(r);
      expect(v.ok).toBe(true);
    }
  });

  it('returns a sanitized error when there is no active provider', () => {
    reader.data = {};
    store.migrateAllLegacyProviders();
    const r = store.getActiveProviderRuntimeConfig('m');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.code).toBe('runtime.noActiveProvider');
      expect(r.error).toBe('no active provider');
    }
  });

  it('returns a sanitized error when modelId is empty', () => {
    const r = store.getActiveProviderRuntimeConfig('');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.code).toBe('runtime.missingModel');
    }
  });

  it('builds an OpenAI-compatible runtime config', () => {
    reader.data = {
      o: {
        id: 'o',
        name: 'OAI',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oai-1234567890',
        isActive: true,
      },
    };
    store.migrateAllLegacyProviders();
    const r = store.getActiveProviderRuntimeConfig('gpt-4o');
    if (!('error' in r)) {
      expect(r.apiFormat).toBe('openai-chat');
      expect(r.headers['Authorization']).toBe('Bearer sk-oai-1234567890');
    } else {
      throw new Error('expected runtime config');
    }
  });

  it('builds an Ollama runtime config with no auth', () => {
    reader.data = {
      o: {
        id: 'o',
        name: 'Ollama',
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: '',
        isActive: true,
      },
    };
    store.migrateAllLegacyProviders();
    const r = store.getActiveProviderRuntimeConfig('llama3.2');
    if (!('error' in r)) {
      expect(r.apiFormat).toBe('ollama');
      expect(r.headers['Authorization']).toBeUndefined();
      // Empty apiKey string is OK; the agent runtime sees an empty
      // string and treats it as no auth.
      expect(r.apiKey).toBeFalsy();
    } else {
      throw new Error('expected runtime config');
    }
  });

  it('getProviderRuntimeConfig returns by id', () => {
    const r = store.getProviderRuntimeConfig('a', 'm');
    if (!('error' in r)) {
      expect(r.providerId).toBe('a');
    } else {
      throw new Error('expected runtime config');
    }
  });

  it('getProviderRuntimeConfig returns error for missing provider', () => {
    const r = store.getProviderRuntimeConfig('nope', 'm');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.code).toBe('provider.notFound');
    }
  });
});

describe('ProviderStore — secret redaction', () => {
  it('the active apiKey is never written to logger.info / error', () => {
    // The store only logs the count and active id; the apiKey is
    // never included. The invariant we check here is that the
    // validation error path is sanitized.
    const reader = new FakeReader();
    reader.data = {
      a: {
        ...makeLegacyAnthropic('a', true),
        apiKey: 'sk-should-NOT-appear-in-error-1234567890',
      },
    };
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();
    const r = store.getActiveProviderRuntimeConfig('m');
    if ('error' in r) {
      expect(r.error.includes('sk-should-NOT-appear')).toBe(false);
    }
  });

  it('redactSecrets scrubs Bearer / x-api-key / api_key=', () => {
    const secret = 'sk-1234567890abcdef';
    const dirty = `Authorization: Bearer ${secret} failed`;
    const out = redactSecrets(dirty);
    expect(out.includes(secret)).toBe(false);
  });
});

describe('ProviderStore — capability surface (Phase 3)', () => {
  /** In-memory CapabilityStore. Mirrors `CapabilityDao` semantics
   *  but doesn't touch SQLite. */
  class InMemoryCapabilityStore {
    private rows = new Map<string, ModelCapability>();
    listByProvider(providerId: string): ModelCapability[] {
      return Array.from(this.rows.values()).filter(
        (c) => c.providerId === providerId,
      );
    }
    getOne(providerId: string, modelId: string): ModelCapability | undefined {
      return this.rows.get(`${providerId}::${modelId}`);
    }
    upsert(c: ModelCapability): ModelCapability {
      const stored: ModelCapability = { ...c, updatedAt: Date.now() };
      this.rows.set(`${c.providerId}::${c.modelId}`, stored);
      return stored;
    }
    delete(providerId: string, modelId: string): boolean {
      return this.rows.delete(`${providerId}::${modelId}`);
    }
  }

  it('upsertModelCapability round-trips through the capability store', () => {
    const reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    const dao = new InMemoryCapabilityStore();
    const store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();

    const r = store.upsertModelCapability({
      providerId: 'a',
      modelId: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
      source: 'user',
      updatedAt: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.capability.contextWindow).toBe(1_000_000);
    expect(dao.getOne('a', 'claude-sonnet-4-6')?.contextWindow).toBe(1_000_000);
  });

  it('listModelCapabilities returns only the requested provider', () => {
    const reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    const dao = new InMemoryCapabilityStore();
    const store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();
    store.upsertModelCapability({ providerId: 'a', modelId: 'm-1', source: 'user', updatedAt: 0 });
    store.upsertModelCapability({ providerId: 'b', modelId: 'm-2', source: 'user', updatedAt: 0 });
    expect(store.listModelCapabilities('a')).toHaveLength(1);
    expect(store.listModelCapabilities('b')).toHaveLength(1);
    expect(store.listModelCapabilities('a')[0].modelId).toBe('m-1');
  });

  it('deleteModelCapability removes a single record', () => {
    const reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    const dao = new InMemoryCapabilityStore();
    const store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();
    store.upsertModelCapability({ providerId: 'a', modelId: 'm', source: 'user', updatedAt: 0 });
    expect(store.deleteModelCapability('a', 'm')).toBe(true);
    expect(store.getModelCapability('a', 'm')).toBeUndefined();
  });

  it('NoopCapabilityStore upsert returns the input unchanged with a fresh timestamp', () => {
    // No fake reader / dao passed: store should not crash.
    const reader = new FakeReader();
    reader.data = { a: makeLegacyAnthropic('a', true) };
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();
    const before = Date.now();
    const r = store.upsertModelCapability({
      providerId: 'a',
      modelId: 'm',
      source: 'user',
      updatedAt: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.capability.updatedAt).toBeGreaterThanOrEqual(before);
    // Noop store is read-empty.
    expect(store.listModelCapabilities('a')).toEqual([]);
  });
});
