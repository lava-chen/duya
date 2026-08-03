/**
 * ProviderStore memory provider / model round-trip tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderStore, type ProviderStoreReader } from '../provider-store';
import type { ApiProvider } from '../../../../src/lib/providers/types';

function makeFakeReader(initial?: {
  memoryId?: string;
  memoryModel?: string | null;
  providers?: Record<string, ApiProvider>;
  defaultId?: string;
}): ProviderStoreReader {
  const state = {
    memoryId: initial?.memoryId,
    memoryModel: initial?.memoryModel ?? null,
    providers: initial?.providers ?? {},
    defaultId: initial?.defaultId,
  };

  return {
    readAll: () => state.providers,
    readOne: (id: string) => state.providers[id],
    readDefault: () => (state.defaultId ? state.providers[state.defaultId] : undefined),
    readMemory: () => (state.memoryId ? state.providers[state.memoryId] : undefined),
    writeMemory: (id: string | null) => {
      state.memoryId = id ?? undefined;
      return true;
    },
    readMemoryModel: () => state.memoryModel,
    writeMemoryModel: (model: string | null) => {
      state.memoryModel = model;
      return true;
    },
    writeAll: vi.fn(() => true),
    onChange: () => () => {},
  };
}

const sampleProvider: ApiProvider = {
  id: 'minimax-cn',
  name: 'MiniMax (CN)',
  providerType: 'minimax',
  baseUrl: 'https://api.minimax.chat/v1',
  apiKey: 'sk-test',
  isActive: true,
  options: { enabled_models: ['MiniMax-M3', 'MiniMax-M2'] },
};

describe('ProviderStore memory provider/model', () => {
  it('reads and writes memory provider id', () => {
    const reader = makeFakeReader({ providers: { 'minimax-cn': { ...sampleProvider, isActive: false } } });
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();

    // No explicit memory provider and no default → undefined.
    expect(store.getMemoryLlmProvider()?.id).toBeUndefined();

    store.setMemoryLlmProvider('minimax-cn');
    expect(store.getMemoryLlmProvider()?.id).toBe('minimax-cn');

    // Clearing memory provider falls back to default (none here).
    store.setMemoryLlmProvider(null);
    expect(store.getMemoryLlmProvider()?.id).toBeUndefined();
  });

  it('falls back to default provider when memory provider is unset', () => {
    const reader = makeFakeReader({
      providers: { 'minimax-cn': sampleProvider },
      defaultId: 'minimax-cn',
    });
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();

    expect(store.getMemoryLlmProvider()?.id).toBe('minimax-cn');
  });

  it('reads and writes memory model override', () => {
    const reader = makeFakeReader({ providers: { 'minimax-cn': sampleProvider } });
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();

    expect(store.getMemoryModel()).toBeNull();

    store.setMemoryModel('minimax-cn:MiniMax-M3');
    expect(store.getMemoryModel()).toBe('minimax-cn:MiniMax-M3');

    store.setMemoryModel(null);
    expect(store.getMemoryModel()).toBeNull();
  });

  it('round-trips provider and model independently', () => {
    const reader = makeFakeReader({ providers: { 'minimax-cn': sampleProvider } });
    const store = new ProviderStore(reader);
    store.migrateAllLegacyProviders();

    store.setMemoryLlmProvider('minimax-cn');
    store.setMemoryModel('minimax-cn:MiniMax-M2');

    expect(store.getMemoryLlmProvider()?.id).toBe('minimax-cn');
    expect(store.getMemoryModel()).toBe('minimax-cn:MiniMax-M2');
  });
});
