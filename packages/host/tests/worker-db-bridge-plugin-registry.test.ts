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
 * are derived by the Desktop from the package files under its Electron
 * `userData`, which a standalone Host does not have.
 *
 * These assertions pin that contract:
 *  - the composite key is split into `id` and `marketplace`;
 *  - `enabled` is reported, and an entry that omits it counts as enabled;
 *  - an entry carries NO install path, because there is none to point at;
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

  it('carries no install path, because the standalone Host has no install directory', async () => {
    const root = configRootWith(
      ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
    );
    try {
      const host = bridge(createHostLocalPluginRegistryApi(root));

      const entries = await host.dispatch('plugin:registry:list', {}) as Array<Record<string, unknown>>;

      // The worker only loads a plugin's skills and MCP servers when it can
      // resolve the package directory. A standalone Host stores nothing
      // there, so it must not claim a path it cannot serve.
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
