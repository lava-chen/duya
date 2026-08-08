// Plan 334 decision 11 — PluginManager.listInstalled() reads only the
// `enabled` flag from ConfigStore and derives every other field from the
// marketplace catalog / cache layout / setup store. This test wires a real
// PluginRegistryStore onto a temp ConfigStore and asserts the merge.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../config/store';
import { _setConfigStoreForTest } from '../config/store-instance';

const state = vi.hoisted(() => {
  const catalogEntry = {
    id: 'com.duya.test-plugin',
    name: 'test-plugin',
    version: '2.0.0',
    description: 'A test plugin',
    source: 'bundled',
    trustLevel: 'official',
    builtinCacheDir: '/tmp/builtin-cache/com.duya.test-plugin/2.0.0',
    manifest: {
      id: 'com.duya.test-plugin',
      name: 'test-plugin',
      version: '2.0.0',
      description: 'A test plugin',
      author: { name: 'DUYA Team' },
      permissions: [{ name: 'workspace.read' }],
      engines: { duya: '>=0.1.0' },
    },
  };
  return {
    tempRoot: '',
    catalogEntry,
    resolveInstalledSymlink: vi.fn(() => ''),
  } as {
    tempRoot: string;
    catalogEntry: typeof catalogEntry;
    resolveInstalledSymlink: ReturnType<typeof vi.fn>;
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.tempRoot,
    getAppPath: () => process.cwd(),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: { Main: 'Main' },
}));

vi.mock('./PluginSetupStore', () => ({
  PluginSetupStore: class {
    getAll() {
      return {};
    }
  },
}));

vi.mock('./catalog', () => ({
  getPluginCatalogEntry: vi.fn((id: string) => (id === 'com.duya.test-plugin' ? state.catalogEntry : undefined)),
  getPluginCatalog: vi.fn(() => [state.catalogEntry]),
}));

vi.mock('./manifest', () => ({
  listCapabilityKinds: vi.fn(() => ['mcp']),
  readPluginManifest: vi.fn(),
}));

vi.mock('./cache/layout', () => ({
  ensurePluginCacheDir: vi.fn(),
  createInstalledSymlink: vi.fn(),
  removeInstalledSymlink: vi.fn(),
  getPluginVersionCacheDir: vi.fn(),
  getPluginInstalledRoot: vi.fn(),
  cleanupOldVersions: vi.fn(),
  resolveInstalledSymlink: vi.fn(() => state.resolveInstalledSymlink()),
}));

vi.mock('./cache/version-resolver', () => ({
  resolvePluginVersion: vi.fn(() => '2.0.0'),
}));

vi.mock('../../packages/plugin-core/src', () => ({
  TrustEngine: class {
    determineTrustLevel() {
      return { level: 'official' };
    }
  },
  PermissionService: class {
    async recordGrantedPermissions() {
      return [];
    }
  },
  PolicyEngine: class {
    isPluginBlocked() {
      return { allowed: true };
    }
    isManagedPluginLocked() {
      return false;
    }
  },
  withPluginError: async (_id: string, _action: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../packages/plugin-core/src/security/path-validator', () => ({
  PathSafetyValidator: class {},
}));

import { PluginManager } from './PluginManager';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-list-installed-'));
  state.tempRoot = dir;
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins-data'), { recursive: true });
  const cfg = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  // Simulate a migrated config: only `enabled` is persisted.
  cfg.set('plugins', {
    'com.duya.test-plugin@builtin': { enabled: true },
  });
  _setConfigStoreForTest(cfg);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PluginManager.listInstalled merge', () => {
  it('derives catalog fields from the marketplace catalog', () => {
    const manager = new PluginManager();
    const installed = manager.listInstalled();

    expect(installed).toHaveLength(1);
    const item = installed[0];
    expect(item).toMatchObject({
      id: 'com.duya.test-plugin',
      enabled: true,
      marketplace: 'builtin',
      name: 'test-plugin',
      version: '2.0.0',
      source: 'bundled',
      trustLevel: 'official',
      scope: 'user',
      autoUpdate: false,
      installPath: '/tmp/builtin-cache/com.duya.test-plugin/2.0.0',
      dataPath: path.join(dir, 'plugins-data', 'com.duya.test-plugin'),
      setupState: 'complete',
      grantedPermissions: [{ name: 'workspace.read' }],
      capabilityKinds: ['mcp'],
    });
    expect(item.health.status).toBe('ready');
  });

  it('local plugin with no catalog entry falls back to minimal defaults', () => {
    const cfg = new ConfigStore({
      configPath: path.join(dir, 'config.toml'),
      secretsPath: path.join(dir, 'secrets.json'),
    });
    cfg.set('plugins', {
      'com.duya.unknown@local': { enabled: true },
    });
    _setConfigStoreForTest(cfg);

    const manager = new PluginManager();
    const item = manager.listInstalled()[0];
    expect(item).toMatchObject({
      id: 'com.duya.unknown',
      enabled: true,
      marketplace: 'local',
      name: 'com.duya.unknown',
      version: '0.1.0',
      source: 'local',
      trustLevel: 'local',
      setupState: 'complete',
    });
    // No catalog manifest -> no granted permissions / capabilities.
    expect(item.grantedPermissions).toEqual([]);
    expect(item.capabilityKinds).toEqual([]);
  });
});