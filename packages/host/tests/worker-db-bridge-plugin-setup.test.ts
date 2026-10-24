/**
 * The plugin setup domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The MCP loader expands `${setup.X}` references in plugin manifests from
 * the values the Host stores per plugin. On the standalone Host the action
 * used to fail with `unimplemented_domain`, so every reference expanded to
 * nothing — and the failure was invisible, because the worker logs a
 * warning and continues.
 *
 * The values come from the same `PluginSetupStore` the HTTP surface serves,
 * so both surfaces answer the same question.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PluginSetupStore } from '@duya/data/plugin-setup-store';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';
import { createHostLocalPluginSetupApi } from '../src/local-plugin-setup-api.js';

function bridge(options: {
  readonly pluginSetupApi?: ReturnType<typeof createHostLocalPluginSetupApi>;
}) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...options,
  });
}

function storeWith(values: Record<string, Record<string, string>>): {
  readonly db: Database.Database;
  readonly store: PluginSetupStore;
} {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_setup_values (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `);
  const store = new PluginSetupStore(db);
  for (const [pluginId, pluginValues] of Object.entries(values)) {
    store.merge(pluginId, pluginValues);
  }
  return { db, store };
}

describe('the standalone Host plugin setup domain', () => {
  it('serves the plugin setup values the MCP loader expands', async () => {
    const { db, store } = storeWith({ 'plugin-1': { endpoint: 'https://example.test' } });
    try {
      const host = bridge({ pluginSetupApi: createHostLocalPluginSetupApi(store) });

      // The MCP loader expands `${setup.endpoint}` from this map; an empty
      // answer expanded every reference to nothing.
      await expect(host.dispatch('plugin:setup:list-all', {})).resolves.toEqual({
        'plugin-1': { endpoint: 'https://example.test' },
      });
    } finally {
      db.close();
    }
  });

  it('serves the values of every plugin, keyed by plugin id', async () => {
    const { db, store } = storeWith({
      'plugin-1': { endpoint: 'https://example.test' },
      'plugin-2': { endpoint: 'https://other.test', token: 'abc' },
    });
    try {
      const host = bridge({ pluginSetupApi: createHostLocalPluginSetupApi(store) });

      await expect(host.dispatch('plugin:setup:list-all', {})).resolves.toEqual({
        'plugin-1': { endpoint: 'https://example.test' },
        'plugin-2': { endpoint: 'https://other.test', token: 'abc' },
      });
    } finally {
      db.close();
    }
  });

  it('fails fast when the Host has not composed the plugin setup API', async () => {
    await expect(bridge({}).dispatch('plugin:setup:list-all', {}))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});
