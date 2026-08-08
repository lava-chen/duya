// Plan 334 decision 11 — PluginRegistryStore is backed by ConfigStore's
// `plugins` block (composite key "<id>@<marketplace>", only `enabled`
// persisted). These tests cover registration/removal through a temp
// ConfigStore injected via `_setConfigStoreForTest`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../config/store';
import { _setConfigStoreForTest } from '../config/store-instance';
import { PluginRegistryStore } from './PluginRegistryStore';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.tempRoot,
    getAppPath: () => process.cwd(),
  },
}));

const state = vi.hoisted(() => ({ tempRoot: '' } as { tempRoot: string }));

let dir: string;
let store: PluginRegistryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-registry-store-'));
  state.tempRoot = dir;
  const cfg = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(cfg);
  store = new PluginRegistryStore();
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fullEntry(overrides: Partial<PluginRegistryStoreEntry> = {}): PluginRegistryStoreEntry {
  return {
    id: 'com.duya.test',
    name: 'test',
    version: '1.0.0',
    enabled: true,
    installPath: '/tmp/install',
    dataPath: '/tmp/data',
    source: 'bundled',
    trustLevel: 'official',
    scope: 'user',
    marketplace: 'builtin',
    autoUpdate: false,
    installedAt: 'now',
    updatedAt: 'now',
    grantedPermissions: [],
    setupState: 'complete',
    health: { status: 'ready', reasons: [], checkedAt: 'now' },
    ...overrides,
  };
}

type PluginRegistryStoreEntry = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installPath: string;
  dataPath: string;
  source: string;
  trustLevel: string;
  scope: string;
  marketplace: string;
  autoUpdate: boolean;
  installedAt: string;
  updatedAt: string;
  grantedPermissions: unknown[];
  setupState: string;
  health: unknown;
};

describe('PluginRegistryStore (ConfigStore-backed)', () => {
  it('upsertPlugin persists only { enabled } under the composite key', () => {
    store.upsertPlugin(fullEntry({ id: 'com.duya.test', marketplace: 'builtin', enabled: true }));

    const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf-8');
    expect(cfg).toContain('com.duya.test@builtin');

    // Only `enabled` is stored — runtime/derived fields are not persisted.
    expect(cfg).not.toContain('installPath');
    expect(cfg).not.toContain('grantedPermissions');
  });

  it('readRegistry returns minimal entries (id/enabled/marketplace)', () => {
    store.upsertPlugin(fullEntry({ id: 'com.duya.test', marketplace: 'builtin', enabled: true }));
    store.upsertPlugin(
      fullEntry({ id: 'com.duya.local', name: 'local', marketplace: 'local', enabled: false }),
    );

    const registry = store.readRegistry();
    expect(registry.version).toBe(1);
    expect(registry.plugins).toHaveLength(2);
    const byId = new Map(registry.plugins.map((p) => [p.id, p]));
    expect(byId.get('com.duya.test')).toMatchObject({ enabled: true, marketplace: 'builtin' });
    expect(byId.get('com.duya.local')).toMatchObject({ enabled: false, marketplace: 'local' });
  });

  it('upsertPlugin toggles enabled without clobbering sibling entries', () => {
    store.upsertPlugin(fullEntry({ id: 'com.duya.a', marketplace: 'builtin', enabled: true }));
    store.upsertPlugin(fullEntry({ id: 'com.duya.b', marketplace: 'builtin', enabled: false }));
    store.upsertPlugin(fullEntry({ id: 'com.duya.a', marketplace: 'builtin', enabled: false }));

    const registry = store.readRegistry();
    const a = registry.plugins.find((p) => p.id === 'com.duya.a');
    const b = registry.plugins.find((p) => p.id === 'com.duya.b');
    expect(a?.enabled).toBe(false);
    expect(b?.enabled).toBe(false);
  });

  it('removePlugin deletes the matching key and returns the removed entry', () => {
    store.upsertPlugin(fullEntry({ id: 'com.duya.a', marketplace: 'builtin' }));
    store.upsertPlugin(fullEntry({ id: 'com.duya.b', marketplace: 'local' }));

    const removed = store.removePlugin('com.duya.a');
    expect(removed).toMatchObject({ id: 'com.duya.a', marketplace: 'builtin' });
    expect(store.listPlugins().map((p) => p.id)).toEqual(['com.duya.b']);

    // Removing a non-existent id returns null.
    expect(store.removePlugin('com.duya.missing')).toBeNull();
  });

  it('parses a legacy key with no marketplace as builtin', () => {
    const cfg = new ConfigStore({
      configPath: path.join(dir, 'config.toml'),
      secretsPath: path.join(dir, 'secrets.json'),
    });
    cfg.set('plugins', { 'legacy-plugin': { enabled: true } });
    _setConfigStoreForTest(cfg);

    const registry = store.readRegistry();
    expect(registry.plugins[0]).toMatchObject({ id: 'legacy-plugin', marketplace: 'builtin', enabled: true });
  });
});