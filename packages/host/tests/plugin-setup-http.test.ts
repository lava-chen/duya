import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginSetupStore } from '@duya/data/plugin-setup-store';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createHostLocalPluginSetupApi } from '../src/local-plugin-setup-api.js';

describe('Host plugin setup HTTP API', () => {
  let db: Database.Database;
  let server: HostSessionHttpServer;
  let client: HostSessionHttpClient;

  beforeEach(async () => {
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
    server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: 'test-token',
      localPluginSetupApi: createHostLocalPluginSetupApi(new PluginSetupStore(db)),
    });
    await server.listen();
    client = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'test-token');
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('merges and clears setup values through the authenticated Host boundary', async () => {
    await client.mergePluginSetupValues('plugin-a', { token: 'secret', endpoint: 'https://old.example' });
    await client.mergePluginSetupValues('plugin-a', { endpoint: 'https://new.example' });

    expect(await client.listPluginSetupValues()).toEqual({
      'plugin-a': { token: 'secret', endpoint: 'https://new.example' },
    });

    await client.clearPluginSetupValues('plugin-a');
    expect(await client.listPluginSetupValues()).toEqual({});
    await expect(
      new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'wrong-token').listPluginSetupValues(),
    ).rejects.toThrow();
  });
});
