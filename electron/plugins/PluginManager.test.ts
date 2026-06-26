import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tempRoot: '',
  cacheDir: '',
  storeEntries: [] as Array<Record<string, unknown>>,
  storeUpsertPlugin: vi.fn(),
  installedUpsertPlugin: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: {
    Main: 'Main',
  },
}));

vi.mock('./catalog', () => ({
  getPluginCatalog: vi.fn(() => []),
  getPluginCatalogEntry: vi.fn((pluginId: string) => {
    if (pluginId !== 'com.duya.literature') {
      return null;
    }
    return {
      id: 'com.duya.literature',
      name: 'Literature Plugin',
      source: 'bundled',
      manifest: {
        id: 'com.duya.literature',
        name: 'Literature Plugin',
        version: '0.1.0',
        permissions: [],
        capabilities: {
          skills: [],
          mcpServers: [
            {
              name: 'literature',
              command: 'node',
              args: ['./agent-bundle/literature-mcp-server.js'],
            },
          ],
          cli: [],
          ui: [],
          hooks: [],
        },
        setup: [],
      },
    };
  }),
  getLocalPluginPaths: vi.fn(() => new Map()),
}));

vi.mock('./manifest', () => ({
  listCapabilityKinds: vi.fn(() => ['mcp']),
  readPluginManifest: vi.fn(),
}));

vi.mock('./PluginRegistryStore', () => ({
  PluginRegistryStore: class {
    getPaths() {
      return {
        installedDir: path.join(state.tempRoot, 'installed'),
        dataDir: path.join(state.tempRoot, 'data'),
        stagingDir: path.join(state.tempRoot, 'staging'),
        registryPath: path.join(state.tempRoot, 'registry.json'),
        lockfilePath: path.join(state.tempRoot, 'lockfile.json'),
      };
    }

    listPlugins() {
      return state.storeEntries;
    }

    upsertPlugin(entry: Record<string, unknown>) {
      state.storeUpsertPlugin(entry);
      state.storeEntries = [entry];
    }
  },
}));

vi.mock('./installed/installed-plugins-manager', () => ({
  getInstalledPluginsManager: () => ({
    upsertPlugin: state.installedUpsertPlugin,
  }),
}));

vi.mock('./cache/layout', () => ({
  ensurePluginCacheDir: vi.fn((_marketplace: string, _pluginId: string, _version: string) => {
    fs.mkdirSync(state.cacheDir, { recursive: true });
    return state.cacheDir;
  }),
  createInstalledSymlink: vi.fn(),
  removeInstalledSymlink: vi.fn(),
  getPluginVersionCacheDir: vi.fn(),
  getPluginInstalledRoot: vi.fn(),
  cleanupOldVersions: vi.fn(),
  resolveInstalledSymlink: vi.fn(),
}));

vi.mock('./cache/version-resolver', () => ({
  resolvePluginVersion: vi.fn(() => '0.1.0'),
}));

vi.mock('./updater/auto-updater', () => ({
  getPluginAutoUpdater: vi.fn(),
}));

vi.mock('../../packages/plugin-core/src', () => ({
  PathSafetyValidator: class {},
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
  PluginSecretStore: class {},
  withPluginError: async (_pluginId: string, _action: string, fn: () => Promise<unknown>) => fn(),
}));

import { PluginManager } from './PluginManager';

describe('PluginManager.installFromCatalog', () => {
  beforeEach(() => {
    state.tempRoot = mkdtempSync(path.join(tmpdir(), 'duya-plugin-manager-'));
    state.cacheDir = path.join(state.tempRoot, 'cache', 'com.duya.literature', '0.1.0');
    state.storeEntries = [];
    state.storeUpsertPlugin.mockReset();
    state.installedUpsertPlugin.mockReset();

    fs.mkdirSync(path.join(state.tempRoot, 'installed'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'staging'), { recursive: true });
  });

  afterEach(() => {
    if (state.tempRoot) {
      rmSync(state.tempRoot, { recursive: true, force: true });
    }
  });

  it('upserts installed plugin metadata after catalog install', async () => {
    const manager = new PluginManager();

    const result = await manager.installFromCatalog('com.duya.literature');

    expect(result).toMatchObject({
      id: 'com.duya.literature',
      version: '0.1.0',
      enabled: true,
    });

    expect(state.storeUpsertPlugin).toHaveBeenCalledTimes(1);
    expect(state.installedUpsertPlugin).toHaveBeenCalledTimes(1);
    expect(state.installedUpsertPlugin).toHaveBeenCalledWith(
      'com.duya.literature',
      expect.objectContaining({
        id: 'com.duya.literature',
        version: '0.1.0',
        marketplace: 'builtin',
      }),
    );

    const manifestPath = path.join(state.cacheDir, 'plugin.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({
      id: 'com.duya.literature',
      name: 'Literature Plugin',
    });
  });
});
