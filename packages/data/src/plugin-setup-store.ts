import type { SqliteDatabase } from './sqlite-connection.js';

/** Data-owned persistence for plugin setup values without exposing a database handle. */
export class PluginSetupStore {
  constructor(private readonly db: SqliteDatabase) {}

  listAll(): Record<string, Record<string, string>> {
    try {
      const tableExists = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_setup_values'",
      ).get();
      if (!tableExists) return {};
      const rows = this.db.prepare(
        'SELECT plugin_id, key, value FROM plugin_setup_values',
      ).all() as Array<{ plugin_id: string; key: string; value: string }>;
      const values: Record<string, Record<string, string>> = {};
      for (const row of rows) {
        if (!values[row.plugin_id]) values[row.plugin_id] = {};
        values[row.plugin_id]![row.key] = row.value;
      }
      return values;
    } catch {
      return {};
    }
  }

  merge(pluginId: string, values: Record<string, string>, now = Date.now()): void {
    const statement = this.db.prepare(`
      INSERT INTO plugin_setup_values (plugin_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const write = this.db.transaction((entries: Array<[string, string]>) => {
      for (const [key, value] of entries) statement.run(pluginId, key, value, now);
    });
    write(Object.entries(values));
  }

  clear(pluginId: string): void {
    this.db.prepare('DELETE FROM plugin_setup_values WHERE plugin_id = ?').run(pluginId);
  }
}
