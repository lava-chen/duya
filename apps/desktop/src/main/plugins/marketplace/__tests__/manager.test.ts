// manager.test.ts — marketplace source removal and hiding (plan 455 follow-up).
//
// The config store and logger are mocked so the tests can observe the exact
// `[marketplaces]` block the manager writes without touching the real
// config.toml or the user's clone cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  marketplaces: {} as Record<string, unknown>,
  plugins: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/duya-test',
  },
}));

vi.mock('../../../config/store-instance', () => ({
  getConfigStore: () => ({
    getByPath: (key: string) =>
      key === 'marketplaces' ? state.marketplaces : key === 'plugins' ? state.plugins : undefined,
    set: (key: string, value: unknown) => {
      if (key === 'marketplaces') state.marketplaces = value as Record<string, unknown>;
    },
  }),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe('marketplace source removal', () => {
  beforeEach(() => {
    state.marketplaces = {};
    state.plugins = {};
  });

  it('deletes a user-added source outright', async () => {
    state.marketplaces = {
      custom: { source: 'local', path: '/tmp/custom' },
    };
    const { removeMarketplace } = await import('../manager.js');

    removeMarketplace('custom');

    expect(state.marketplaces.custom).toBeUndefined();
  });

  it('keeps a removed default source as a tombstone', async () => {
    state.marketplaces = {
      official: {
        source: 'git',
        displayName: 'DUYA Official',
        urls: ['https://github.com/lava-chen/duya-marketplace.git'],
      },
    };
    const { removeMarketplace } = await import('../manager.js');

    removeMarketplace('official');

    expect(state.marketplaces.official).toMatchObject({ removed: true });
  });

  it('refuses to remove a source that still has installed plugins', async () => {
    state.marketplaces = {
      custom: { source: 'local', path: '/tmp/custom' },
    };
    state.plugins = { 'com.duya.thing@custom': { enabled: true } };
    const { removeMarketplace } = await import('../manager.js');

    expect(() => removeMarketplace('custom')).toThrow(/still has installed plugins/);
    expect(state.marketplaces.custom).toBeDefined();
  });
});

describe('marketplace source hiding', () => {
  beforeEach(() => {
    state.marketplaces = {
      custom: { source: 'local', path: '/tmp/custom' },
    };
  });

  it('sets and clears the hidden flag', async () => {
    const { setMarketplaceHidden } = await import('../manager.js');

    setMarketplaceHidden('custom', true);
    expect(state.marketplaces.custom).toMatchObject({ hidden: true });

    setMarketplaceHidden('custom', false);
    expect((state.marketplaces.custom as { hidden?: boolean }).hidden).toBeUndefined();
  });

  it('rejects removed and unknown sources', async () => {
    const { setMarketplaceHidden } = await import('../manager.js');

    expect(() => setMarketplaceHidden('missing', true)).toThrow(/not configured/);
    state.marketplaces.removed = { source: 'local', path: '/tmp/x', removed: true };
    expect(() => setMarketplaceHidden('removed', true)).toThrow(/not configured/);
  });
});

describe('ensureOfficialMarketplace', () => {
  beforeEach(() => {
    state.marketplaces = {};
  });

  it('does not restore a default source that the user removed', async () => {
    state.marketplaces = {
      official: { source: 'git', urls: ['https://github.com/lava-chen/duya-marketplace.git'], removed: true },
    };
    const { ensureOfficialMarketplace, DEFAULT_OFFICIAL_SOURCES } = await import('../manager.js');

    ensureOfficialMarketplace();

    expect(state.marketplaces.official).toMatchObject({ removed: true });
    // The other defaults are still seeded.
    for (const seed of DEFAULT_OFFICIAL_SOURCES) {
      if (seed.registryName !== 'official') {
        expect(state.marketplaces[seed.registryName]).toBeDefined();
      }
    }
  });
});
