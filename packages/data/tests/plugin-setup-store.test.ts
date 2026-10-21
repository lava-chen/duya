import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginSetupStore } from '../src/plugin-setup-store.js';

describe('PluginSetupStore', () => {
  let db: Database.Database;
  let store: PluginSetupStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE plugin_setup_values (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      )
    `);
    store = new PluginSetupStore(db);
  });

  afterEach(() => db.close());

  it('atomically merges values, preserves omitted secrets, and clears one plugin', () => {
    store.merge('plugin-a', { token: 'secret', endpoint: 'https://old.example' }, 100);
    store.merge('plugin-b', { account: 'keep' }, 100);
    store.merge('plugin-a', { endpoint: 'https://new.example' }, 200);

    expect(store.listAll()).toEqual({
      'plugin-a': { token: 'secret', endpoint: 'https://new.example' },
      'plugin-b': { account: 'keep' },
    });

    store.clear('plugin-a');
    expect(store.listAll()).toEqual({ 'plugin-b': { account: 'keep' } });
  });
});
