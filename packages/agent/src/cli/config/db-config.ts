/**
 * Database-based Configuration for CLI
 * 
 * Uses the same database as the app (src/lib/db.ts)
 * Providers are stored in api_providers table
 * Settings are stored in settings table
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { getConfigDatabasePath } from '../../config.js';

// Default database path
function getDefaultDbPath(): string {
  // Always use production database path for CLI
  // This ensures CLI and App share the same database
  let userDataPath: string;

  if (process.platform === 'win32') {
    userDataPath = process.env.APPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    userDataPath = join(process.env.HOME || homedir(), 'Library', 'Application Support');
  } else {
    userDataPath = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  }

  return join(userDataPath, 'DUYA', 'duya.db');
}

// Get database path - checks for custom path in config file first, then environment variable
function getDbPath(): string {
  // Check for custom database path from config file (highest priority)
  const configDbPath = getConfigDatabasePath();
  if (configDbPath && configDbPath.trim()) {
    return join(configDbPath.trim(), 'duya.db');
  }

  // Check for custom database path from environment variable (set by Electron app)
  if (process.env.DUYA_CUSTOM_DB_PATH) {
    return process.env.DUYA_CUSTOM_DB_PATH;
  }

  // Use default path
  return getDefaultDbPath();
}

let db: Database.Database | null = null;

export function initCliDatabase(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  const dbDir = dirname(dbPath);

  console.log('[Agent DB] Database path:', dbPath);
  console.log('[Agent DB] Database dir:', dbDir);
  console.log('[Agent DB] Dir exists:', existsSync(dbDir));

  if (!existsSync(dbDir)) {
    console.log('[Agent DB] Creating directory:', dbDir);
    mkdirSync(dbDir, { recursive: true });
  }

  console.log('[Agent DB] Opening database...');
  try {
    db = new Database(dbPath);
    console.log('[Agent DB] Database opened successfully');
  } catch (err) {
    console.error('[Agent DB] Failed to open database:', err);
    console.log('[Agent DB] Falling back to in-memory database');
    db = new Database(':memory:');
    console.log('[Agent DB] Using in-memory database');
  }

  // Try to set WAL mode, but don't fail if it doesn't work
  // (e.g., on Windows with certain file system configurations)
  // On Windows, WAL mode can cause issues with file locking
  if (process.platform !== 'win32') {
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      // WAL mode is optional, continue without it
    }
  }

  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Ensure tables exist (same as app's initDatabase)
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      protocol TEXT NOT NULL DEFAULT '',
      headers_json TEXT NOT NULL DEFAULT '{}',
      options_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS INTEGER))
    )
  `);

  return db;
}

export function getCliDatabase(): Database.Database {
  if (!db) return initCliDatabase();
  return db;
}

// Provider interface matching the app's ApiProviderRow
export interface CliProvider {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  is_active: number;
  sort_order: number;
  extra_env: string;
  protocol: string;
  headers_json: string;
  options_json: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

// Get all providers
export function getAllCliProviders(): CliProvider[] {
  const db = getCliDatabase();
  return db.prepare('SELECT * FROM api_providers ORDER BY sort_order ASC').all() as CliProvider[];
}

// Get active provider
export function getActiveCliProvider(): CliProvider | null {
  const db = getCliDatabase();
  return db.prepare('SELECT * FROM api_providers WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1').get() as CliProvider | null;
}

// Create or update provider
export function upsertCliProvider(data: {
  id?: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  isActive?: boolean;
  extraEnv?: Record<string, string>;
  protocol?: string;
  notes?: string;
}): CliProvider {
  const db = getCliDatabase();
  const now = Date.now();
  const id = data.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, extra_env, protocol, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      provider_type = excluded.provider_type,
      base_url = excluded.base_url,
      api_key = excluded.api_key,
      is_active = COALESCE(excluded.is_active, is_active),
      extra_env = COALESCE(excluded.extra_env, extra_env),
      protocol = COALESCE(excluded.protocol, protocol),
      notes = COALESCE(excluded.notes, notes),
      updated_at = excluded.updated_at
  `).run(
    id,
    data.name,
    data.providerType,
    data.baseUrl,
    data.apiKey,
    data.isActive ? 1 : 0,
    JSON.stringify(data.extraEnv || {}),
    data.protocol || '',
    data.notes || '',
    now,
    now
  );

  return db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as CliProvider;
}

// Activate a provider (deactivates others)
export function activateCliProvider(id: string): CliProvider | null {
  const db = getCliDatabase();
  const now = Date.now();

  const transaction = db.transaction(() => {
    db.prepare('UPDATE api_providers SET is_active = 0, updated_at = ?').run(now);
    db.prepare('UPDATE api_providers SET is_active = 1, updated_at = ? WHERE id = ?').run(now, id);
  });

  transaction();
  return db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as CliProvider | null;
}

// Delete provider
export function deleteCliProvider(id: string): boolean {
  const db = getCliDatabase();
  const result = db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);
  return result.changes > 0;
}

// Settings
export function getCliSetting(key: string): string | null {
  const db = getCliDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setCliSetting(key: string, value: string): void {
  const db = getCliDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function getCliSettingJson<T>(key: string, defaultValue: T): T {
  const value = getCliSetting(key);
  if (value === null) return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

export function setCliSettingJson<T>(key: string, value: T): void {
  setCliSetting(key, JSON.stringify(value));
}

// Mask API key for display
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= 8) {
    return '***';
  }
  return '***' + apiKey.slice(-8);
}

// Close database
export function closeCliDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
