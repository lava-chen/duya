import { describe, expect, it } from 'vitest';
import { buildInitProviderConfig, resolveRuntimeConfigViaDbRequest } from '../router';
import type { ApiProvider } from '../../../config/provider-types';

/**
 * Compaction budget fix: the worker's DuyaAgent reads
 * `runtimeConfig.modelCapabilities.contextWindow` from the init
 * providerConfig to size the compaction budget. Without it every worker
 * falls back to the 200k default, so 1M-window models compact at ~18%
 * of the window shown in the context ring.
 *
 * These tests cover the server-side pieces:
 * 1. `buildInitProviderConfig` carries `providerId` so the enrichment
 *    call can resolve capabilities for the exact provider.
 * 2. `resolveRuntimeConfigViaDbRequest` forwards the (providerId, model)
 *    pair to the main-process bridge and unwraps the runtimeConfig —
 *    best-effort on every failure path.
 */

function makeProvider(overrides: Partial<ApiProvider> = {}): ApiProvider {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test',
    options: { defaultModel: 'default-model' },
    ...overrides,
  } as ApiProvider;
}

describe('buildInitProviderConfig providerId', () => {
  it('includes the provider store id so capability resolution targets the right provider', () => {
    const provider = makeProvider();
    const config = buildInitProviderConfig({ model: 'my-model' }, provider);
    expect(config).not.toBeUndefined();
    expect(config!.providerId).toBe('prov-1');
    expect(config!.model).toBe('my-model');
  });

  it('still builds without a provider (legacy no-provider branch has no providerId)', () => {
    const config = buildInitProviderConfig({ model: 'my-model' }, undefined);
    expect(config).toEqual({ model: 'my-model' });
  });
});

describe('resolveRuntimeConfigViaDbRequest', () => {
  const runtime = { providerId: 'prov-1', modelCapabilities: { contextWindow: 1_000_000 } };

  it('resolves the runtimeConfig through the dbRequest bridge', async () => {
    const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const result = await resolveRuntimeConfigViaDbRequest(async (action, payload) => {
      calls.push({ action, payload });
      return runtime;
    }, { providerId: 'prov-1', model: 'my-model' });

    expect(result).toEqual(runtime);
    expect(calls).toEqual([
      { action: 'config:provider:resolveRuntime', payload: { providerId: 'prov-1', model: 'my-model' } },
    ]);
  });

  it('sends empty strings when the input lacks providerId/model', async () => {
    let seen: Record<string, unknown> | undefined;
    await resolveRuntimeConfigViaDbRequest(async (_action, payload) => {
      seen = payload;
      return runtime;
    }, {});
    expect(seen).toEqual({ providerId: '', model: '' });
  });

  it('resolves undefined when no dbRequest bridge is available', async () => {
    const result = await resolveRuntimeConfigViaDbRequest(undefined, { model: 'm' });
    expect(result).toBeUndefined();
  });

  it('resolves undefined when the bridge returns null/non-object', async () => {
    expect(await resolveRuntimeConfigViaDbRequest(async () => null, { model: 'm' })).toBeUndefined();
    expect(await resolveRuntimeConfigViaDbRequest(async () => 'nope', { model: 'm' })).toBeUndefined();
  });

  it('resolves undefined (never throws) when the bridge rejects', async () => {
    const result = await resolveRuntimeConfigViaDbRequest(async () => {
      throw new Error('bridge down');
    }, { providerId: 'prov-1', model: 'm' });
    expect(result).toBeUndefined();
  });
});
