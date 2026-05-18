/**
 * queries/settings.ts - Settings key-value SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * All functions operate on settings table.
 */

import { getDatabase } from '../connection';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

function db(): BetterSqlite3 {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return d;
}

export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const now = Date.now();
  db().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function getAllSettings(): Record<string, string> {
  const rows = db().prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

export function getJsonSetting<T = unknown>(key: string, defaultValue: T): T {
  const value = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!value) return defaultValue;
  try {
    return JSON.parse(value.value) as T;
  } catch {
    return defaultValue;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  const now = Date.now();
  db().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
}