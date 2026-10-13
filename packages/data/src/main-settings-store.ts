import type { SqliteDatabase } from './core-database.js';

/** Typed access to settings persisted in the main application database. */
export class MainSettingsStore {
  constructor(private readonly db: SqliteDatabase) {}

  getString(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  }

  getAllStrings(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    return settings;
  }

  setString(key: string, value: string, updatedAt = Date.now()): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, updatedAt);
  }
}
