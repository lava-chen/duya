import { describe, expect, it } from 'vitest';
import { completeProviderConfigFromSession } from '../router';
import type { ApiProvider } from '../../../config/provider-types';

/**
 * The TUI reaches the Desktop Host over HTTP and names a model. It cannot
 * send an API key: the key lives in the Desktop's provider store, and a
 * client that sends no credentials used to make the turn either fail with
 * "No provider or model configured" or run against a worker that had no key.
 *
 * The session row is the record of what the session runs under -- it is where
 * a `/model` switch lands -- so it is what completes the config.
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

const provider = makeProvider();

function bridge(overrides: Record<string, unknown> = {}) {
  return async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'config:provider:get') {
      return payload['id'] === provider.id ? provider : null;
    }
    if (action === 'config:provider:getActive') return provider;
    return overrides[action];
  };
}

describe('completeProviderConfigFromSession', () => {
  it('fills the credential in from the provider store when the caller sent none', async () => {
    const completed = await completeProviderConfigFromSession(
      { model: 'named-model', providerId: 'prov-1' },
      { model: 'session-model', provider_id: 'prov-1' },
      bridge(),
    );
    expect(completed).toMatchObject({
      apiKey: 'sk-test',
      providerId: 'prov-1',
      // The model the caller named wins: it is the model this turn asked for.
      model: 'named-model',
    });
  });

  it('takes the model from the session row when the caller named none', async () => {
    const completed = await completeProviderConfigFromSession(
      undefined,
      { model: 'session-model', provider_id: 'prov-1' },
      bridge(),
    );
    expect(completed).toMatchObject({
      apiKey: 'sk-test',
      providerId: 'prov-1',
      model: 'session-model',
    });
  });

  it('falls back to the active provider when the session names none', async () => {
    const completed = await completeProviderConfigFromSession(
      undefined,
      { model: 'session-model', provider_id: '' },
      bridge(),
    );
    expect(completed).toMatchObject({ providerId: 'prov-1', model: 'session-model' });
  });

  it('has nothing to complete without a session row', async () => {
    expect(await completeProviderConfigFromSession(undefined, undefined, bridge())).toBeUndefined();
  });
});
