/**
 * src/lib/providers/__tests__/capability-sync.test.ts
 *
 * Tests for ModelCapabilityService and ModelSyncService's fallback path.
 *
 * Note: we do not exercise the live fetch (would require a mock fetch or
 * a local server). The fallback-to-defaultModels path is the critical one
 * to keep stable; the live path is verified by integration tests downstream.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCapabilityService } from '../models/ModelCapabilityService';
import { ModelSyncService } from '../models/ModelSyncService';
import type { LlmProvider, ProviderPreset } from '../types';

function makeProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'p1',
    name: 'P1',
    category: 'aggregator',
    apiFormat: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-1234567890' },
    endpoints: { baseUrl: 'https://example.com' },
    ui: {},
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    ...overrides,
  };
}

function staticPreset(): ProviderPreset {
  return {
    key: 'test-static',
    name: 'Test',
    category: 'aggregator',
    apiFormat: 'anthropic',
    authFields: [],
    defaultEndpoint: 'https://example.com',
    modelsSource: { type: 'static' },
    defaultModels: ['m-a', 'm-b'],
    defaultModelLabels: { 'm-a': 'Model A', 'm-b': 'Model B' },
    ui: {},
  };
}

describe('ModelCapabilityService', () => {
  let svc: ModelCapabilityService;
  beforeEach(() => {
    svc = new ModelCapabilityService();
  });

  it('merges preset models', () => {
    svc.mergePresetModels('p1', ['m-a', 'm-b'], { 'm-a': 'Model A' });
    const list = svc.listModels('p1');
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.modelId === 'm-a')?.displayName).toBe('Model A');
    expect(list.every((m) => m.source === 'preset')).toBe(true);
  });

  it('does not overwrite existing records', () => {
    svc.upsertModelCapability({
      providerId: 'p1',
      modelId: 'm-a',
      source: 'user',
      updatedAt: 0,
      contextWindow: 100_000,
    });
    svc.mergePresetModels('p1', ['m-a']);
    expect(svc.getModelCapability('p1', 'm-a')?.contextWindow).toBe(100_000);
    expect(svc.getModelCapability('p1', 'm-a')?.source).toBe('user');
  });

  it('updates contextWindow', () => {
    svc.mergePresetModels('p1', ['m-a']);
    svc.updateContextWindow('p1', 'm-a', 1_000_000);
    expect(svc.getModelCapability('p1', 'm-a')?.contextWindow).toBe(1_000_000);
  });

  it('isolates providers', () => {
    svc.mergePresetModels('p1', ['m-a']);
    svc.mergePresetModels('p2', ['m-b']);
    expect(svc.listModels('p1')).toHaveLength(1);
    expect(svc.listModels('p2')).toHaveLength(1);
  });
});

describe('ModelSyncService fallback to defaultModels', () => {
  it('returns the preset default models when modelsSource is static', async () => {
    const svc = new ModelSyncService();
    const provider = makeProvider();
    // Use a real preset (anthropic-official) to verify the registry lookup.
    const result = await svc.syncProviderModels(provider, 'anthropic-official');
    expect(result.ok).toBe(true);
    expect(result.source).toBe('static');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => m.source === 'preset')).toBe(true);
    expect(result.models.map((m) => m.modelId)).toContain('claude-sonnet-4-6');
  });

  it('returns an empty list when there is no preset and source is static', async () => {
    const svc = new ModelSyncService();
    const provider = makeProvider();
    const result = await svc.syncProviderModels(provider);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('static');
    expect(result.models).toEqual([]);
  });
});
