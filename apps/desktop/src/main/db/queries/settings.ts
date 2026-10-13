/**
 * queries/settings.ts - Settings key-value SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * All functions operate on settings table.
 */

import { getDatabase } from '../connection';
import { MainSettingsStore } from '@duya/data/main-settings-store';

function store(): MainSettingsStore {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return new MainSettingsStore(d);
}

export function getSetting(key: string): string | null {
  return store().getString(key);
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
  const value = store().getString(key);
  if (value === null) return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Setting value is not JSON serializable');
  store().setString(key, serialized);
}
