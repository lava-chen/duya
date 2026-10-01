import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tempRoot: '',
  fixtureDir: '',
  cacheDir: '',
  storeEntries: [] as Array<Record<string, unknown>>,
  storeUpsertPlugin: vi.fn(),
  storeRemovePlugin: vi.fn(),
  consentClear: vi.fn(),
  consentDbAvailable: true,
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
  // Plan 455 — plugins come from marketplaces: the catalog entry carries
  // `marketplacePluginDir` (the fenced clone dir) and a v2 manifest read
  // from `.duya-plugin/plugin.json`. PluginManager copies the entire dir.
  getPluginCatalogEntry: vi.fn((pluginId: string) => {
    if (pluginId !== 'com.duya.test-plugin') {
      return null;
    }
    return {
      id: 'com.duya.test-plugin',
      name: 'test-plugin',
      source: 'marketplace',
      marketplace: 'official',
      marketplacePluginDir: state.fixtureDir,
      manifest: {
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.test-plugin',
        name: 'test-plugin',
        version: '0.1.0',
        description: 'Test plugin for install flow.',
        author: { name: 'DUYA Team' },
        capabilities: {
          skills: ['test-skill'],
          mcpServers: [
            { name: 'test-mcp', command: 'node', args: ['server.js'] },
          ],
        },
        components: {
          mcpServers: ['test-mcp'],
          appConnections: [],
          skills: ['test-skill'],
          workflows: [],
        },
        permissions: [{ name: 'workspace.read' }],
        setup: undefined,
        engines: { duya: '>=0.1.0' },
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
      };
    }

    listPlugins() {
      return state.storeEntries;
    }

    upsertPlugin(entry: Record<string, unknown>) {
      state.storeUpsertPlugin(entry);
      state.storeEntries = [entry];
    }

    removePlugin(pluginId: string) {
      state.storeRemovePlugin(pluginId);
      const found = state.storeEntries.find((e) => e.id === pluginId);
      state.storeEntries = state.storeEntries.filter((e) => e.id !== pluginId);
      return found;
    }
  },
}));

// Plan 583 seam C — hook-execution consent is purged on every remove. The
// database and the consent store are mocked so the assertion is on the
// wiring, not on SQL, which `pluginHookConsent.test.ts` already covers.
vi.mock('../db/index', () => ({
  getDatabase: () => (state.consentDbAvailable ? { __mock: true } : null),
}));

vi.mock('../db/pluginHookConsent', () => ({
  clearPluginHookConsent: (_db: unknown, pluginId: string) => {
    state.consentClear(pluginId);
  },
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

vi.mock('../../packages/plugin-core/src', () => ({
  TrustEngine: class {
    determineTrustLevel() {
      return { level: 'official' };
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
  withPluginError: async (_pluginId: string, _action: string, fn: () => Promise<unknown>) => fn(),
  withPluginErrorSync: (_pluginId: string, _action: string, fn: () => unknown) => fn(),
}));

vi.mock('../../packages/plugin-core/src/security/path-validator', () => ({
  PathSafetyValidator: class {},
}));

import { PluginManager } from './PluginManager';

/**
 * Build a minimal on-disk fixture plugin at state.fixtureDir with the
 * `.duya-plugin/plugin.json` + skills/ + mcp/ layout that
 * PluginManager.installFromCatalog copies from `marketplacePluginDir`.
 */
function buildFixturePlugin(dir: string): void {
  mkdirSync(path.join(dir, '.duya-plugin'), { recursive: true });
  writeFileSync(
    path.join(dir, '.duya-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'test-plugin',
      version: '0.1.0',
      description: 'Test plugin for install flow.',
      author: { name: 'DUYA Team' },
      license: 'MIT',
    }, null, 2),
  );

  mkdirSync(path.join(dir, 'skills', 'test-skill'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'test-skill', 'SKILL.md'), '# test-skill\n');

  mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  writeFileSync(
    path.join(dir, 'mcp', 'servers.json'),
    JSON.stringify({ servers: [{ name: 'test-mcp', command: 'node', args: ['server.js'] }] }, null, 2),
  );

  mkdirSync(path.join(dir, 'permissions'), { recursive: true });
  writeFileSync(
    path.join(dir, 'permissions', 'policy.json'),
    JSON.stringify({ defaultMode: 'workspace', permissions: [] }, null, 2),
  );
}

describe('PluginManager.installFromCatalog', () => {
  beforeEach(() => {
    state.tempRoot = mkdtempSync(path.join(tmpdir(), 'duya-plugin-manager-'));
    state.fixtureDir = path.join(state.tempRoot, 'fixture', 'test-plugin');
    state.cacheDir = path.join(state.tempRoot, 'cache', 'com.duya.test-plugin', '0.1.0');
    state.storeEntries = [];
    state.storeUpsertPlugin.mockReset();

    fs.mkdirSync(path.join(state.tempRoot, 'installed'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'staging'), { recursive: true });

    buildFixturePlugin(state.fixtureDir);
  });

  afterEach(() => {
    if (state.tempRoot) {
      rmSync(state.tempRoot, { recursive: true, force: true });
    }
  });

  it('upserts installed plugin metadata after catalog install', async () => {
    const manager = new PluginManager();

    const result = await manager.installFromCatalog('com.duya.test-plugin');

    expect(result).toMatchObject({
      id: 'com.duya.test-plugin',
      version: '0.1.0',
      enabled: true,
    });

    expect(state.storeUpsertPlugin).toHaveBeenCalledTimes(1);
    expect(state.storeUpsertPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'com.duya.test-plugin',
        version: '0.1.0',
        marketplace: 'official',
      }),
    );

    // The install copies the entire marketplace plugin dir (including
    // `.duya-plugin/plugin.json`), NOT a synthesised inline `plugin.json`.
    const minimalManifestPath = path.join(state.cacheDir, '.duya-plugin', 'plugin.json');
    expect(existsSync(minimalManifestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(minimalManifestPath, 'utf8'))).toMatchObject({
      name: 'test-plugin',
      version: '0.1.0',
    });

    // The legacy root `plugin.json` is NOT written — disk is the single source.
    expect(existsSync(path.join(state.cacheDir, 'plugin.json'))).toBe(false);

    // Skill assets are copied from the fixture dir.
    expect(
      existsSync(path.join(state.cacheDir, 'skills', 'test-skill', 'SKILL.md')),
    ).toBe(true);

    // MCP server config is copied from the fixture dir.
    expect(existsSync(path.join(state.cacheDir, 'mcp', 'servers.json'))).toBe(true);
  });
});

describe('PluginManager.remove — hook consent (plan 583 seam C)', () => {
  beforeEach(() => {
    state.tempRoot = mkdtempSync(path.join(tmpdir(), 'duya-plugin-remove-'));
    state.storeEntries = [];
    state.storeRemovePlugin.mockReset();
    state.consentClear.mockReset();
    state.consentDbAvailable = true;

    fs.mkdirSync(path.join(state.tempRoot, 'installed'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(state.tempRoot, 'staging'), { recursive: true });
  });

  afterEach(() => {
    if (state.tempRoot) {
      rmSync(state.tempRoot, { recursive: true, force: true });
    }
  });

  function seedInstalled(pluginId: string): void {
    state.storeEntries = [
      {
        id: pluginId,
        installPath: path.join(state.tempRoot, 'cache', pluginId),
        dataPath: path.join(state.tempRoot, 'data', pluginId),
      },
    ];
  }

  it('purges hook consent even when the user keeps their plugin data', async () => {
    // The load-bearing case. `deleteData: false` is the normal upgrade path:
    // the settings and secrets stay, but a reinstall brings new code that the
    // old `granted` never described. Consent is about code, not data, so it
    // must not survive the uninstall.
    seedInstalled('com.duya.p');
    const manager = new PluginManager();

    await manager.remove('com.duya.p', false);

    expect(state.consentClear).toHaveBeenCalledWith('com.duya.p');
  });

  it('purges hook consent when the data is deleted too', async () => {
    seedInstalled('com.duya.p');
    const manager = new PluginManager();

    await manager.remove('com.duya.p', true);

    expect(state.consentClear).toHaveBeenCalledWith('com.duya.p');
  });

  it('does not purge consent for a plugin that was not installed', async () => {
    // `removePlugin` returning nothing means the remove was a no-op; there is
    // no install to invalidate, so no row should be touched.
    const manager = new PluginManager();

    const result = await manager.remove('com.duya.absent', false);

    expect(result).toMatchObject({ removed: false });
    expect(state.consentClear).not.toHaveBeenCalled();
  });

  it('completes the remove when the database is unavailable', async () => {
    // Non-fatal by design: a leftover row is only reachable on a later
    // reinstall, and the gate fails closed on anything unexpected. Failing the
    // uninstall instead would leave the user unable to remove a plugin.
    seedInstalled('com.duya.p');
    state.consentDbAvailable = false;
    const manager = new PluginManager();

    const result = await manager.remove('com.duya.p', false);

    expect(result).toMatchObject({ removed: true });
    expect(state.consentClear).not.toHaveBeenCalled();
  });
});
