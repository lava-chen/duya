/**
 * electron/services/providers/__tests__/model-catalog.test.ts
 *
 * Plan 334 Phase 4 tests: the DB-backed override layer (`ModelCatalogStore`)
 * and the ProviderStore behavior that overlays DB user/runtime overrides on
 * the built-in `@duya/ai` baseline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ProviderStore,
  type ProviderStoreReader,
} from '../provider-store';
import { ModelCatalogStore } from '../model-catalog-store';
import type { ApiProvider, ModelCapability } from '../../../../src/lib/providers/types';

// Mock the model-sync singleton so `syncProviderModels` never hits the
// network. Path is relative to THIS test file.
const syncSpy = vi.fn();
vi.mock('../../../../src/lib/providers/models/ModelSyncService', () => ({
  modelSyncService: { syncProviderModels: (...args: unknown[]) => syncSpy(...args) },
}));

class FakeReader implements ProviderStoreReader {
  data: Record<string, ApiProvider> = {};
  defaultId: string | undefined = undefined;
  readAll() {
    return { ...this.data };
  }
  readOne(id: string) {
    return this.data[id];
  }
  readDefault() {
    return this.defaultId ? this.data[this.defaultId] : undefined;
  }
  writeAll(map: Record<string, ApiProvider>): boolean {
    this.data = { ...map };
    return true;
  }
  onChange(_cb: () => void): () => void {
    return () => {};
  }
}

/** In-memory CapabilityStore mirroring `CapabilityDao` row semantics. */
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

function makeAnthropicProvider(id: string, isActive = false): ApiProvider {
  return {
    id,
    name: id,
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-1234567890',
    isActive,
  };
}

describe('ModelCatalogStore — override layer', () => {
  it('getOverrides / upsertOverride round-trip through the inner store', () => {
    const inner = new InMemoryCapabilityStore();
    const catalog = new ModelCatalogStore(inner);
    catalog.upsertOverride({
      providerId: 'a',
      modelId: 'm',
      contextWindow: 1000,
      source: 'user',
      updatedAt: 0,
    });
    expect(catalog.getOverrides('a', 'm')?.contextWindow).toBe(1000);
    expect(inner.getOne('a', 'm')?.contextWindow).toBe(1000);
  });

  it('never persists a preset row — coerced to user', () => {
    const inner = new InMemoryCapabilityStore();
    const catalog = new ModelCatalogStore(inner);
    catalog.upsertOverride({
      providerId: 'a',
      modelId: 'm',
      source: 'preset',
      updatedAt: 0,
    });
    const stored = catalog.getOverrides('a', 'm');
    expect(stored?.source).toBe('user');
    expect(inner.getOne('a', 'm')?.source).toBe('user');
  });

  it('keeps models-api as a legitimate runtime override source', () => {
    const inner = new InMemoryCapabilityStore();
    const catalog = new ModelCatalogStore(inner);
    catalog.upsertOverride({
      providerId: 'a',
      modelId: 'm',
      source: 'models-api',
      updatedAt: 0,
    });
    expect(catalog.getOverrides('a', 'm')?.source).toBe('models-api');
  });

  it('deleteOverride removes a single override row', () => {
    const inner = new InMemoryCapabilityStore();
    const catalog = new ModelCatalogStore(inner);
    catalog.upsertOverride({ providerId: 'a', modelId: 'm', source: 'user', updatedAt: 0 });
    expect(catalog.deleteOverride('a', 'm')).toBe(true);
    expect(catalog.getOverrides('a', 'm')).toBeUndefined();
  });
});

describe('ProviderStore — DB override feeds runtime config', () => {
  let reader: FakeReader;
  let dao: InMemoryCapabilityStore;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    reader.data = { anthropic: makeAnthropicProvider('anthropic', true) };
    dao = new InMemoryCapabilityStore();
    store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();
  });

  it('getActiveProviderRuntimeConfig auto-loads the DB override as capabilities', () => {
    dao.upsert({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      contextWindow: 300_000,
      source: 'user',
      updatedAt: 0,
    });
    // No capabilities passed — the store must pull the DB row itself.
    const r = store.getActiveProviderRuntimeConfig('claude-sonnet-4-20250514');
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.modelCapabilities?.contextWindow).toBe(300_000);
    }
  });

  it('getProviderRuntimeConfig auto-loads the DB override as capabilities', () => {
    dao.upsert({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      contextWindow: 400_000,
      source: 'user',
      updatedAt: 0,
    });
    const r = store.getProviderRuntimeConfig('anthropic', 'claude-sonnet-4-20250514');
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.modelCapabilities?.contextWindow).toBe(400_000);
    }
  });

  it('explicitly-passed capabilities still win over the DB row', () => {
    dao.upsert({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      contextWindow: 300_000,
      source: 'user',
      updatedAt: 0,
    });
    const r = store.getProviderRuntimeConfig(
      'anthropic',
      'claude-sonnet-4-20250514',
      {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        supportsVision: true,
        contextWindow: 999,
        source: 'user',
        updatedAt: 0,
      },
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.modelCapabilities?.contextWindow).toBe(999);
    }
  });
});

describe('ProviderStore — listModelCapabilitiesMerged baseline + override', () => {
  let reader: FakeReader;
  let dao: InMemoryCapabilityStore;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    reader.data = { anthropic: makeAnthropicProvider('anthropic', true) };
    dao = new InMemoryCapabilityStore();
    store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();
  });

  it('merges built-in baseline with DB overrides, DB winning', () => {
    // Built-in anthropic baseline has claude-sonnet-4-20250514
    // (contextWindow 200000). Override it via DB.
    dao.upsert({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      contextWindow: 500_000,
      source: 'user',
      updatedAt: 0,
    });
    const merged = store.listModelCapabilitiesMerged('anthropic');
    const sonnet = merged.find((m) => m.modelId === 'claude-sonnet-4-20250514');
    expect(sonnet).toBeTruthy();
    expect(sonnet!.contextWindow).toBe(500_000); // DB override wins
    expect(sonnet!.source).toBe('user');
    // The untouched built-in model is still present from the baseline.
    const older = merged.find((m) => m.modelId === 'claude-3-5-sonnet-20241022');
    expect(older).toBeTruthy();
    expect(older!.source).toBe('preset');
  });

  it('returns DB rows only when the provider is unknown (no baseline)', () => {
    dao.upsert({ providerId: 'custom', modelId: 'm-x', source: 'user', updatedAt: 0 });
    const merged = store.listModelCapabilitiesMerged('custom');
    expect(merged).toHaveLength(1);
    expect(merged[0].modelId).toBe('m-x');
  });

  it('listModelCapabilities still returns DB rows (unmerged, legacy behavior)', () => {
    dao.upsert({ providerId: 'anthropic', modelId: 'm-x', source: 'user', updatedAt: 0 });
    const rows = store.listModelCapabilities('anthropic');
    expect(rows).toHaveLength(1);
    expect(rows[0].modelId).toBe('m-x');
  });
});

describe('ProviderStore — syncProviderModels writes override rows', () => {
  let reader: FakeReader;
  let dao: InMemoryCapabilityStore;
  let store: ProviderStore;

  beforeEach(() => {
    reader = new FakeReader();
    reader.data = { anthropic: makeAnthropicProvider('anthropic', true) };
    dao = new InMemoryCapabilityStore();
    store = new ProviderStore(reader, dao);
    store.migrateAllLegacyProviders();
    syncSpy.mockReset();
  });

  it('persists synced models as models-api override rows', async () => {
    syncSpy.mockResolvedValue({
      ok: true,
      source: 'models-api',
      models: [
        { providerId: 'anthropic', modelId: 'gpt-synced', source: 'models-api', updatedAt: 0 },
      ],
    });
    const res = await store.syncProviderModels('anthropic');
    expect(res.ok).toBe(true);
    const row = dao.getOne('anthropic', 'gpt-synced');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('models-api');
  });

  it('skips persistence when sync returns empty', async () => {
    syncSpy.mockResolvedValue({ ok: true, source: 'static', models: [] });
    await store.syncProviderModels('anthropic');
    expect(dao.listByProvider('anthropic')).toHaveLength(0);
  });
});