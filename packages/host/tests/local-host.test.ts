import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

describe('standalone local Host', () => {
  it('serves authenticated health and persists settings across restarts', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-test-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    const options = {
      dataRoot,
      databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
      port: 0,
      token: 'local-host-test-token',
    };
    let host: LocalHostHandle | undefined;

    try {
      host = await startLocalHost(options);
      let client = new HostSessionHttpClient(host.origin, options.token);

      // `toMatchObject`, not `toEqual`: the handshake carries additive
      // capability fields beyond the three asserted here, and a client must be
      // able to ignore the ones it does not know. Pinning the whole payload
      // would make every additive field a breaking change for this test.
      expect(await client.getHealth()).toMatchObject({
        ok: true,
        apiVersion: 1,
        databaseReady: true,
      });
      await client.setSetting('host.test.persistence', 'written-by-host');

      await host.close();
      host = undefined;

      host = await startLocalHost(options);
      client = new HostSessionHttpClient(host.origin, options.token);
      await expect(client.getSetting('host.test.persistence')).resolves.toBe('written-by-host');
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('maps a config pin to the previous Electron default onto the shared data root', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-legacy-db-'));
    const dataRoot = path.join(temporaryRoot, 'new-data');
    const appDataRoot = path.join(temporaryRoot, 'app-data');
    const previous = {
      dataRoot: process.env.DUYA_DATA_ROOT,
      test: process.env.DUYA_TEST,
      testNamespace: process.env.DUYA_TEST_NAMESPACE,
      appData: process.env.APPDATA,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      home: process.env.HOME,
    };
    let host: LocalHostHandle | undefined;

    try {
      process.env.DUYA_DATA_ROOT = dataRoot;
      delete process.env.DUYA_TEST;
      delete process.env.DUYA_TEST_NAMESPACE;
      if (process.platform === 'win32') {
        process.env.APPDATA = appDataRoot;
      } else if (process.platform === 'darwin') {
        process.env.HOME = path.join(temporaryRoot, 'home');
      } else {
        process.env.XDG_CONFIG_HOME = appDataRoot;
      }

      const oldUserDataRoot = process.platform === 'darwin'
        ? path.join(temporaryRoot, 'home', 'Library', 'Application Support', 'DUYA')
        : path.join(appDataRoot, 'DUYA');
      const oldDatabasePath = path.join(oldUserDataRoot, 'databases', 'duya-main.db');
      await fs.mkdir(path.dirname(oldDatabasePath), { recursive: true });
      const oldDatabase = new Database(oldDatabasePath);
      oldDatabase.exec('CREATE TABLE previous_data_marker (value TEXT NOT NULL)');
      oldDatabase.prepare('INSERT INTO previous_data_marker (value) VALUES (?)').run('kept');
      oldDatabase.close();

      const escapedDatabasePath = oldDatabasePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await fs.mkdir(dataRoot, { recursive: true });
      await fs.writeFile(
        path.join(dataRoot, 'config.toml'),
        `[storage]\ndatabase_path = "${escapedDatabasePath}"\n`,
      );

      const token = 'local-host-legacy-db-token';
      host = await startLocalHost({ port: 0, token });
      const client = new HostSessionHttpClient(host.origin, token);

      expect(await client.getHealth()).toMatchObject({ ok: true, databaseReady: true });
      await expect(fs.access(path.join(dataRoot, 'duya-main.db'))).resolves.toBeUndefined();
      await expect(fs.access(oldDatabasePath)).resolves.toBeUndefined();
      const migratedDatabase = new Database(path.join(dataRoot, 'duya-main.db'), { readonly: true });
      expect(migratedDatabase.prepare('SELECT value FROM previous_data_marker').get()).toEqual({ value: 'kept' });
      migratedDatabase.close();
    } finally {
      await host?.close();
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('DUYA_DATA_ROOT', previous.dataRoot);
      restore('DUYA_TEST', previous.test);
      restore('DUYA_TEST_NAMESPACE', previous.testNamespace);
      restore('APPDATA', previous.appData);
      restore('XDG_CONFIG_HOME', previous.xdgConfigHome);
      restore('HOME', previous.home);
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
