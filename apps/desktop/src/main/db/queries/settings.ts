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

/**
 * Read a string setting.
 *
 * The renderer picks the write shape by the value's runtime type
 * (`useSettings.ts` save(): `typeof value === 'string'` -> `settingsDb.set`,
 * anything else -> `settingsDb.setJson`), so a string-typed key can be
 * legitimately in EITHER shape: stored verbatim, or stored as a
 * JSON-encoded string. A raw read returns the JSON form's quotes and
 * escapes, which silently corrupts every string consumer — a `workspaceDir`
 * of `C:\ws` arrives as `"C:\\ws"` and is handed to the worker verbatim.
 *
 * So unwrap exactly the JSON-encoded-STRING case, the same tolerance the
 * renderer read path already applies to `locale` / `gatewayModel` /
 * `agentLanguage` (see `parseAppSettings`). Every other stored value —
 * including secrets, paths and anything merely wrapped in quotes that is
 * not valid JSON — is returned byte-identical.
 *
 * Non-string settings (object / array / number / boolean / null) are NOT
 * handled here: this contract returns `string | null`, so a key written
 * with `setJson` for such a value must be read with `getJsonSetting`.
 */
export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  const raw = row.value;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded === 'string') return decoded;
    } catch {
      // Not valid JSON after all — a raw value that merely looks quoted.
    }
  }
  return raw;
}

// ============================================================================
// Plan 487 — host-level standing permission switch
// ============================================================================

const HOST_LOCAL_TOOL_PERMISSION_KEY = 'host.localToolPermission'
const HOST_LOCAL_TOOL_PERMISSIONS_SET: ReadonlySet<string> = new Set([
  'ask',
  'always',
  'never',
])

function isLocalToolPermission(value: unknown): value is 'ask' | 'always' | 'never' {
  return typeof value === 'string' && HOST_LOCAL_TOOL_PERMISSIONS_SET.has(value)
}

/**
 * Read the host-level persistent tool permission switch (plan 487).
 * Returns `'ask'` when the value is missing or malformed.
 */
export function getHostToolPermission(): 'ask' | 'always' | 'never' {
  const value = getJsonSetting<unknown>(HOST_LOCAL_TOOL_PERMISSION_KEY, 'ask')
  return isLocalToolPermission(value) ? value : 'ask'
}

/**
 * Persist the host-level persistent tool permission switch (plan 487).
 * Throws on invalid input — callers must validate against the 3-state union.
 */
export function setHostToolPermission(
  value: 'ask' | 'always' | 'never',
): void {
  if (!isLocalToolPermission(value)) {
    throw new Error(`Invalid host tool permission: ${String(value)}`)
  }
  setJsonSetting(HOST_LOCAL_TOOL_PERMISSION_KEY, value)
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