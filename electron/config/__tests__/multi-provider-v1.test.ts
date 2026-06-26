/**
 * multi-provider-v1 — migration tests
 *
 * Covers the four branches of the boot-time migration:
 *  1. copy the lone active provider to defaultProviderId
 *  2. skip when the marker is already set (idempotency)
 *  3. do not copy when multiple active providers exist
 *  4. reset isActive to false on every provider
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    isPackaged: false,
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  LogComponent: {
    ConfigManager: 'ConfigManager',
  },
}));

import { migrateMultiProviderV1 } from '../migrations/multi-provider-v1';

function makeConfigManager(opts: {
  defaultProviderId?: string | null;
  marker?: boolean;
  providers: Array<{ id: string; isActive?: boolean; name?: string; providerType?: string; apiKey?: string }>;
}) {
  const config: { defaultProviderId: string | null; migrations: Record<string, boolean> } = {
    defaultProviderId: opts.defaultProviderId ?? null,
    migrations: opts.marker ? { 'multi-provider-v1': true } : {},
  };
  const upsertProvider = vi.fn();
  const setDefaultProvider = vi.fn((id: string | null) => {
    config.defaultProviderId = id;
    return true;
  });
  const setConfig = vi.fn((key: string, value: unknown) => {
    if (key === 'migrations') {
      config.migrations = value as Record<string, boolean>;
    }
    return true;
  });
  return {
    config: {
      getConfig: () => config,
      getAllProviders: () => Object.fromEntries(opts.providers.map((p) => [p.id, p])),
      getDefaultProvider: () => {
        const id = config.defaultProviderId;
        return id ? opts.providers.find((p) => p.id === id) : undefined;
      },
      setDefaultProvider,
      upsertProvider,
      setConfig,
    } as never,
    setDefaultProvider,
    upsertProvider,
    setConfig,
  };
}

describe('migrateMultiProviderV1', () => {
  it('copies the lone active provider to defaultProviderId', () => {
    const { config, setDefaultProvider } = makeConfigManager({
      providers: [
        { id: 'a', isActive: true },
        { id: 'b', isActive: false },
      ],
    });
    migrateMultiProviderV1(config);
    expect(setDefaultProvider).toHaveBeenCalledWith('a');
  });

  it('skips when marker is present', () => {
    const { config, setDefaultProvider } = makeConfigManager({
      marker: true,
      providers: [{ id: 'a', isActive: true }],
    });
    migrateMultiProviderV1(config);
    expect(setDefaultProvider).not.toHaveBeenCalled();
  });

  it('does not copy when multiple active providers exist', () => {
    const { config, setDefaultProvider } = makeConfigManager({
      providers: [
        { id: 'a', isActive: true },
        { id: 'b', isActive: true },
      ],
    });
    migrateMultiProviderV1(config);
    expect(setDefaultProvider).not.toHaveBeenCalled();
  });

  it('resets isActive on every provider', () => {
    const { config, upsertProvider } = makeConfigManager({
      providers: [
        { id: 'a', isActive: true, name: 'A', providerType: 'anthropic', apiKey: 'k' },
        { id: 'b', isActive: false, name: 'B', providerType: 'openai', apiKey: 'k' },
      ],
    });
    migrateMultiProviderV1(config);
    const callForA = upsertProvider.mock.calls.find((c) => (c[0] as { id: string }).id === 'a');
    expect(callForA?.[0]).toMatchObject({ id: 'a', isActive: false });
  });

  it('writes the migration marker', () => {
    const { config, setConfig } = makeConfigManager({
      providers: [{ id: 'a', isActive: true }],
    });
    migrateMultiProviderV1(config);
    expect(setConfig).toHaveBeenCalledWith(
      'migrations',
      expect.objectContaining({ 'multi-provider-v1': true }),
      'main',
    );
  });
});
