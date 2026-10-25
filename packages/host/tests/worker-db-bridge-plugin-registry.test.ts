/**
 * The plugin registry of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The worker asks the Host which plugins are installed before it builds its
 * tool registry and its skill paths. On the standalone Host that action used
 * to fail with `unimplemented_domain`, and the worker answered it with an
 * empty plugin set — silently, because a failed lookup is logged and
 * swallowed.
 *
 * ## What the standalone Host can honestly say
 *
 * `config.toml`'s `[plugins]` block is the only persisted source of the
 * installed-plugin list: the key is `<pluginId>@<marketplace>` and the value
 * carries the user's intent (`enabled`). The install path and the manifest
 * are derived from the package files on disk, wherever they live — the
 * Desktop's Electron `userData` or the shared data root.
 *
 * These assertions pin that contract:
 *  - the composite key is split into `id` and `marketplace`;
 *  - `enabled` is reported, and an entry that omits it counts as enabled;
 *  - an installed plugin carries its resolved path and MCP declarations;
 *  - a plugin with no package directory on disk carries NO install path;
 *  - a missing or malformed `config.toml` yields an empty list, not a crash.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge } from '../src/worker-db-bridge.js';
import { createHostLocalPluginRegistryApi } from '../src/local-plugin-registry-api.js';

function bridge(pluginRegistryApi?: ReturnType<typeof createHostLocalPluginRegistryApi>) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...(pluginRegistryApi === undefined ? {} : { pluginRegistryApi }),
  });
}

/** Write a `config.toml` into a throwaway config root. */
function configRootWith(configToml: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-plugin-registry-'));
  fs.writeFileSync(path.join(root, 'config.toml'), configToml, 'utf8');
  return root;
}

describe('the standalone Host plugin registry', () => {
  it('splits the composite key into the plugin id and its marketplace', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
    );
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      expect(entries).toEqual([
        { id: 'com.duya.documents', name: 'com.duya.documents', enabled: true, marketplace: 'official' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a disabled plugin as disabled', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = false', ''].join('\n'),
    );
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ id: 'com.duya.documents', enabled: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts an entry without an explicit flag as enabled', async () => {
    const root = configRootWith(['[plugins."com.duya.documents@official"]', ''].join('\n'));
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      expect(entries[0]).toMatchObject({ id: 'com.duya.documents', enabled: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists every configured plugin', async () => {
    const root = configRootWith(
      [
        '[plugins."com.duya.documents@official"]',
        'enabled = true',
        '',
        '[plugins."com.duya.sheets@community"]',
        'enabled = false',
        '',
      ].join('\n'),
    );
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      expect(entries.map((entry) => entry.id)).toEqual(['com.duya.documents', 'com.duya.sheets']);
      expect(entries.map((entry) => entry.marketplace)).toEqual(['official', 'community']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries no install path when the plugin package is not on disk', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
    );
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      // The worker only loads a plugin's skills and MCP servers when it can
      // resolve the package directory. A plugin that was never installed has
      // no such directory, so the Host must not claim a path it cannot serve.
      expect(entries[0].installPath).toBeUndefined();
      expect(entries[0].manifest).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the install path and the MCP declarations of an installed plugin', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
    );
    try {
      const installed = path.join(root, 'plugins', 'installed', 'com.duya.documents');
      fs.mkdirSync(path.join(installed, 'mcp'), { recursive: true });
      fs.writeFileSync(
        path.join(installed, 'mcp', 'servers.json'),
        JSON.stringify({ servers: [{ name: 'documents', command: 'documents-mcp' }] }),
        'utf8',
      );

      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      expect(entries[0].installPath).toBe(fs.realpathSync(installed));
      const manifest = entries[0].manifest as {
        capabilities?: { mcpServers?: Array<{ name: string; command?: string }> };
      };
      expect(manifest.capabilities?.mcpServers).toEqual([
        { name: 'documents', command: 'documents-mcp' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not walk the package directory of a disabled plugin', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = false', ''].join('\n'),
    );
    try {
      const installed = path.join(root, 'plugins', 'installed', 'com.duya.documents');
      fs.mkdirSync(installed, { recursive: true });

      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      // A disabled plugin is never loaded by the worker, so the Host does not
      // spend a filesystem walk on it.
      expect(entries[0].installPath).toBeUndefined();
      expect(entries[0].manifest).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers with an empty list when no plugin is configured', async () => {
    const root = configRootWith(['[model]', 'provider = "test"', ''].join('\n'));
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      await expect(host.dispatch('plugin:registry:list', {})).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers with an empty list when the config file is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-plugin-registry-'));
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      await expect(host.dispatch('plugin:registry:list', {})).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers with an empty list when the config file cannot be parsed', async () => {
    const root = configRootWith('this is not = = toml\n');
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      // A hand-edited config.toml must not take the worker down.
      await expect(host.dispatch('plugin:registry:list', {})).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
