/**
 * PluginSetupStore — SQLite-backed storage for plugin setup values.
 *
 * Stores user-supplied values for `text` / `secret` / `path` / `url` setup
 * fields declared in a plugin manifest's `setup` block. The store is keyed
 * by `(plugin_id, key)` so each plugin owns its own namespace.
 *
 * `app-connection` setup fields do NOT flow through this store — they use
 * the OAuth path and the safeStorage-encrypted vault in `app-connections/`.
 *
 * Unlike `PluginRegistryStore` (file-based JSON), this store uses the main
 * SQLite database via better-sqlite3 prepared statements, because setup
 * values are mutated frequently from the UI and must be durable.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { getLogger, LogComponent } from '../logging/logger';

type Db = BetterSqlite3.Database;

interface SetupValueRow {
  key: string;
  value: string;
}

export class PluginSetupStore {
  private readonly logger = getLogger();

  /**
   * Resolve the singleton database connection. The DB may be unavailable
   * during safe mode; callers that can tolerate that should catch the
   * thrown error. We fetch lazily on every call so the store can be
   * constructed before the DB is initialized (PluginManager is a
   * singleton created at module load).
   */
  private getDb(): Db {
    const db = getDatabase();
    if (!db) {
      throw new Error('Database is not initialized (safe mode)');
    }
    return db;
  }

  /** Returns the stored value for a single key, or undefined. */
  get(pluginId: string, key: string): string | undefined {
    const db = this.getDb();
    const row = db
      .prepare('SELECT value FROM plugin_setup_values WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as { value: string } | undefined;
    return row?.value;
  }

  /** Returns all stored key/value pairs for a plugin. */
  getAll(pluginId: string): Record<string, string> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT key, value FROM plugin_setup_values WHERE plugin_id = ?')
      .all(pluginId) as SetupValueRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /** Upsert a single key. */
  set(pluginId: string, key: string, value: string): void {
    const db = this.getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO plugin_setup_values (plugin_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(pluginId, key, value, now);
  }

  /**
   * Full replacement of all setup values for a plugin. Existing rows for
   * `pluginId` are deleted and the supplied `values` are inserted in a
   * single transaction. Callers that need to preserve unchanged secrets
   * must merge before calling this.
   */
  setAll(pluginId: string, values: Record<string, string>): void {
    const db = this.getDb();
    const now = Date.now();
    const delStmt = db.prepare('DELETE FROM plugin_setup_values WHERE plugin_id = ?');
    const upsertStmt = db.prepare(
      `INSERT INTO plugin_setup_values (plugin_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const txn = db.transaction((entries: Array<[string, string]>) => {
      delStmt.run(pluginId);
      for (const [key, value] of entries) {
        upsertStmt.run(pluginId, key, value, now);
      }
    });
    txn(Object.entries(values));
  }

  /** Delete a single key. No-op if the key does not exist. */
  delete(pluginId: string, key: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM plugin_setup_values WHERE plugin_id = ? AND key = ?').run(
      pluginId,
      key,
    );
  }

  /** Delete all stored values for a plugin. Used on uninstall. */
  clear(pluginId: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM plugin_setup_values WHERE plugin_id = ?').run(pluginId);
    this.logger.debug('Cleared plugin setup values', { pluginId }, LogComponent.Main);
  }
}
