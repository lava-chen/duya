// apps/desktop/src/main/plugins/builtin-install.test.ts
// Builtin plugin distribution — registering the shipped plugins.
//
// The distribution promise is "the plugin is already installed". That has to
// happen without stealing a decision the user already made, and it has to
// survive a plugin that cannot be installed at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const state = vi.hoisted(() => ({ appPath: '' }));

const mocks = vi.hoisted(() => ({
  installFromCatalog: vi.fn(),
  setEnabled: vi.fn(),
  listInstalled: vi.fn(),
  resolveInstalledSymlink: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.appPath,
    getAppPath: () => state.appPath,
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  LogComponent: { Main: 'Main' },
}));

vi.mock('./PluginManager', () => ({
  getPluginManager: () => ({
    installFromCatalog: mocks.installFromCatalog,
    setEnabled: mocks.setEnabled,
    listInstalled: mocks.listInstalled,
  }),
}));

vi.mock('./cache/layout', () => ({
  resolveInstalledSymlink: mocks.resolveInstalledSymlink,
}));

/** Directory the dev build reads the marketplace plugins from. */
function marketplaceDir(): string {
  return join(state.appPath, 'resources', 'builtin-plugins');
}

function writePlugin(name: string, opts: { id?: string; version?: string } = {}): void {
  const dir = join(marketplaceDir(), name);
  mkdirSync(join(dir, '.duya-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.duya-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      id: opts.id ?? `com.duya.${name}`,
      version: opts.version ?? '1.0.0',
      description: `${name} plugin`,
    }),
    'utf8',
  );
}

function writeManifest(plugins: unknown): void {
  mkdirSync(marketplaceDir(), { recursive: true });
  writeFileSync(
    join(marketplaceDir(), 'builtin-plugins.json'),
    JSON.stringify({ version: 1, plugins }),
    'utf8',
  );
}

beforeEach(() => {
  state.appPath = mkdtempSync(join(tmpdir(), 'duya-builtin-install-'));
  mocks.installFromCatalog.mockReset().mockResolvedValue({ success: true, data: {} });
  mocks.setEnabled.mockReset().mockResolvedValue({ success: true, data: {} });
  mocks.listInstalled.mockReset().mockReturnValue([]);
  mocks.resolveInstalledSymlink.mockReset().mockReturnValue(null);
});

afterEach(() => {
  rmSync(state.appPath, { recursive: true, force: true });
});

describe('applyBuiltinPluginDefaults', () => {
  it('does nothing when the build shipped no manifest', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    const outcome = await applyBuiltinPluginDefaults();

    expect(outcome.installed).toEqual([]);
    expect(mocks.installFromCatalog).not.toHaveBeenCalled();
  });

  it('registers a shipped plugin and leaves it off when the manifest says so', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    writePlugin('computer-use', { id: 'com.duya.computer-use', version: '0.6.0' });
    writeManifest([{ name: 'computer-use', path: './computer-use', defaultEnabled: false }]);

    const outcome = await applyBuiltinPluginDefaults();

    expect(mocks.installFromCatalog).toHaveBeenCalledWith('com.duya.computer-use');
    expect(mocks.setEnabled).toHaveBeenCalledWith('com.duya.computer-use', false);
    expect(outcome.installed).toEqual(['com.duya.computer-use']);
  });

  it('registers a shipped plugin enabled when the manifest says so', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    writePlugin('notes');
    writeManifest([{ name: 'notes', path: './notes', defaultEnabled: true }]);

    const outcome = await applyBuiltinPluginDefaults();

    expect(mocks.installFromCatalog).toHaveBeenCalledWith('com.duya.notes');
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(outcome.installed).toEqual(['com.duya.notes']);
  });

  it('keeps the state of a plugin the user already turned off', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    writePlugin('computer-use', { id: 'com.duya.computer-use' });
    writeManifest([{ name: 'computer-use', path: './computer-use', defaultEnabled: true }]);
    mocks.listInstalled.mockReturnValue([{ id: 'com.duya.computer-use', enabled: false }]);

    await applyBuiltinPluginDefaults();

    expect(mocks.setEnabled).toHaveBeenCalledWith('com.duya.computer-use', false);
  });

  it('does not reinstall a plugin that is already at the bundled version', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    writePlugin('computer-use', { id: 'com.duya.computer-use', version: '0.6.0' });
    writeManifest([{ name: 'computer-use', path: './computer-use' }]);
    mocks.resolveInstalledSymlink.mockReturnValue(join(marketplaceDir(), 'computer-use'));

    const outcome = await applyBuiltinPluginDefaults();

    expect(mocks.installFromCatalog).not.toHaveBeenCalled();
    expect(outcome.unchanged).toEqual(['com.duya.computer-use']);
  });

  it('reports an install that failed without touching the other plugins', async () => {
    const { applyBuiltinPluginDefaults } = await import('./builtin-install.js');
    writePlugin('broken', { id: 'com.duya.broken' });
    writePlugin('working', { id: 'com.duya.working' });
    writeManifest([
      { name: 'broken', path: './broken' },
      { name: 'working', path: './working' },
    ]);
    mocks.installFromCatalog.mockImplementation(async (id: string) =>
      id === 'com.duya.broken'
        ? { success: false, error: { type: 'generic-error', message: 'nope' } }
        : { success: true, data: {} },
    );

    const outcome = await applyBuiltinPluginDefaults();

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].id).toBe('com.duya.broken');
    expect(outcome.installed).toEqual(['com.duya.working']);
  });
});
