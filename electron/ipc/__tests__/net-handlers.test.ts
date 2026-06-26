/**
 * net-handlers.test.ts — Unit tests for `resolveFetchProviderModelsBody`.
 *
 * The body resolver is the Plan 209 fix-up for masked API keys: when
 * the renderer fetches models for an existing provider, it only has
 * the masked hint (e.g. `sk-a***cdef`), so the main process must
 * look up the real key from the on-disk store. This module is the
 * critical security boundary for provider models fetching.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stored = {
    current: null as null | {
      id: string;
      auth: { apiKey?: string };
      endpoints?: { baseUrl?: string };
      protocol?: string;
    },
  };

  return {
    stored,
    isMaskedKey: vi.fn((k: string | undefined): boolean => {
      if (!k) return false;
      return /\*+/.test(k);
    }),
    providerStore: {
      getLlmProvider: vi.fn((id: string) => {
        return stored.current?.id === id ? stored.current : undefined;
      }),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    networkMocks: {
      testProviderConnection: vi.fn(),
      getProviderUsage: vi.fn(),
      testBridgeChannel: vi.fn(),
      startWeixinQrLogin: vi.fn(),
      pollWeixinQrStatus: vi.fn(),
      cancelWeixinQrSession: vi.fn(),
      fetchOllamaModels: vi.fn(),
      fetchProviderModels: vi.fn(),
    },
  };
});

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../../src/lib/providers/secret', () => ({
  isMaskedKey: mocks.isMaskedKey,
}));

vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => mocks.providerStore,
}));

vi.mock('../../services/network/provider-tester', () => ({
  testProviderConnection: mocks.networkMocks.testProviderConnection,
}));

vi.mock('../../services/network/provider-usage', () => ({
  getProviderUsage: mocks.networkMocks.getProviderUsage,
}));

vi.mock('../../services/network/bridge-tester', () => ({
  testBridgeChannel: mocks.networkMocks.testBridgeChannel,
}));

vi.mock('../../services/network/wechat-qr', () => ({
  startWeixinQrLogin: mocks.networkMocks.startWeixinQrLogin,
  pollWeixinQrStatus: mocks.networkMocks.pollWeixinQrStatus,
  cancelWeixinQrSession: mocks.networkMocks.cancelWeixinQrSession,
}));

vi.mock('../../services/network/model-detector', () => ({
  fetchOllamaModels: mocks.networkMocks.fetchOllamaModels,
}));

vi.mock('../../services/network/model-fetcher', () => ({
  fetchProviderModels: mocks.networkMocks.fetchProviderModels,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getLocale: vi.fn(() => 'en-US'),
    getLocaleCountryCode: vi.fn(() => 'US'),
  },
}));

import { resolveFetchProviderModelsBody, registerNetHandlers } from '../net-handlers';

describe('resolveFetchProviderModelsBody', () => {
  beforeEach(() => {
    mocks.stored.current = null;
    mocks.providerStore.getLlmProvider.mockClear();
    mocks.isMaskedKey.mockClear();
  });

  describe('returns body unchanged when caller already provided a real key', () => {
    it('passes through when api_key is set and not masked', async () => {
      const body = { provider_id: 'p1', api_key: 'sk-real-key' };
      const result = await resolveFetchProviderModelsBody(body);
      expect(result).toEqual(body);
      expect(mocks.providerStore.getLlmProvider).not.toHaveBeenCalled();
    });

    it('does not look up the store if api_key is unmasked', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored-key' },
        endpoints: { baseUrl: 'https://stored.example.com' },
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-caller-key',
      });
      expect(result.api_key).toBe('sk-caller-key');
      expect(mocks.providerStore.getLlmProvider).not.toHaveBeenCalled();
    });
  });

  describe('returns body unchanged when masked key is supplied', () => {
    it('skips store lookup if api_key is masked (no provider_id fallback)', async () => {
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-a***cdef');
      expect(mocks.providerStore.getLlmProvider).toHaveBeenCalledWith('p1');
    });
  });

  describe('returns body unchanged when no provider_id is given', () => {
    it('skips store lookup when provider_id is missing', async () => {
      const result = await resolveFetchProviderModelsBody({
        api_key: 'sk-a***cdef',
      });
      expect(mocks.providerStore.getLlmProvider).not.toHaveBeenCalled();
      expect(result.api_key).toBe('sk-a***cdef');
    });
  });

  describe('falls back to on-disk key when store has a real one', () => {
    it('uses the stored apiKey when body key is masked', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored-real-key' },
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-stored-real-key');
    });

    it('uses the stored baseUrl when body did not supply one', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored' },
        endpoints: { baseUrl: 'https://stored.example.com' },
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.base_url).toBe('https://stored.example.com');
    });

    it('prefers the body baseUrl over the stored one', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored' },
        endpoints: { baseUrl: 'https://stored.example.com' },
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
        base_url: 'https://override.example.com',
      });
      expect(result.base_url).toBe('https://override.example.com');
    });

    it('uses the stored protocol when body did not supply one', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored' },
        protocol: 'openai',
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.protocol).toBe('openai');
    });

    it('prefers the body protocol over the stored one', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-stored' },
        protocol: 'openai',
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
        protocol: 'anthropic',
      });
      expect(result.protocol).toBe('anthropic');
    });
  });

  describe('returns body unchanged when store lacks a real key', () => {
    it('store has no auth', async () => {
      mocks.stored.current = { id: 'p1', auth: {} };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-a***cdef');
    });

    it('store apiKey is also masked', async () => {
      mocks.stored.current = {
        id: 'p1',
        auth: { apiKey: 'sk-b***xxxx' },
      };
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-a***cdef');
    });

    it('store has no entry for provider_id', async () => {
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'unknown',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-a***cdef');
    });
  });

  describe('resilience: store throws', () => {
    it('returns body unchanged when getProviderStore throws', async () => {
      mocks.providerStore.getLlmProvider.mockImplementationOnce(() => {
        throw new Error('store unavailable');
      });
      const result = await resolveFetchProviderModelsBody({
        provider_id: 'p1',
        api_key: 'sk-a***cdef',
      });
      expect(result.api_key).toBe('sk-a***cdef');
    });
  });
});

describe('registerNetHandlers', () => {
  it('registers all expected IPC channels', async () => {
    const { ipcMain } = await import('electron');
    registerNetHandlers();
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'net:provider:test',
        'net:provider:usage',
        'net:bridge:test',
        'net:weixin:qr:start',
        'net:weixin:qr:poll',
        'net:weixin:qr:cancel',
        'net:ollama:models',
        'net:provider:models',
      ]),
    );
  });
});
