/**
 * boot-config.ts - Boot Configuration Manager (The Compass)
 *
 * Reads/writes `~/.duya/config.toml` (the `[storage]` block) as the single
 * source of truth for the database path. boot.json is gone (plan 334,
 * decision 6): `storage.database_path` now lives in config.toml.
 *
 * Design principles:
 * - Plaintext config.toml (must be readable at the earliest stage of startup)
 * - Atomic writes (prevent corruption on power loss)
 * - Minimal content (only the storage block when writing)
 * - Backward compatible (migrates from old duya-config.json format)
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse, stringify } from '@iarna/toml';
import writeFileAtomic from 'write-file-atomic';
import { getLogger, LogComponent } from '../logging/logger';
import { resolveConfigTomlPath, resolveDatabasePathFromConfigToml } from './compass';

const logger = getLogger();

export interface BootConfig {
  databasePath: string;
}

function getDefaultDatabaseDir(): string {
  return path.join(app.getPath('userData'), 'databases');
}

function getDefaultDatabasePath(): string {
  return path.join(getDefaultDatabaseDir(), 'duya-main.db');
}

function ensureDatabaseDir(dbPath: string): void {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * Migrate from old duya-config.json format to config.toml.
 * The old format stored databasePath in a different file location.
 */
function migrateFromLegacyConfig(): string | undefined {
  const legacyPaths = [
    path.join(app.getPath('userData'), 'DUYA', 'duya-config.json'),
    path.join(app.getPath('userData'), 'duya-config.json'),
  ];

  for (const legacyPath of legacyPaths) {
    try {
      if (fs.existsSync(legacyPath)) {
        const content = fs.readFileSync(legacyPath, 'utf-8');
        const config = JSON.parse(content) as { databasePath?: string };
        if (config.databasePath?.trim()) {
          logger.info('Migrating legacy config', { legacyPath }, LogComponent.ConfigManager);
          const oldDbPath = config.databasePath.trim();
          const newDbPath = path.join(oldDbPath, 'duya-main.db');
          if (fs.existsSync(path.join(oldDbPath, 'duya.db')) && !fs.existsSync(newDbPath)) {
            logger.info('Legacy database file found, will be renamed during DB init', undefined, LogComponent.ConfigManager);
          }
          return newDbPath;
        }
      }
    } catch {
      // ignore read errors for legacy files
    }
  }
  return undefined;
}

/**
 * Read the database path from config.toml synchronously.
 * This is called at the very start of app lifecycle - must be fast and reliable.
 * Returns the databasePath, or undefined if not configured in config.toml.
 */
export function readBootConfig(): BootConfig | undefined {
  const dbPath = resolveDatabasePathFromConfigToml();
  return dbPath && dbPath.trim() ? { databasePath: dbPath } : undefined;
}

/**
 * Write `storage.database_path` into config.toml atomically.
 * Preserves any existing keys; only the storage block is touched.
 */
export function writeBootConfig(config: BootConfig): boolean {
  try {
    const cfgPath = resolveConfigTomlPath();
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let doc: Record<string, unknown> = {};
    if (fs.existsSync(cfgPath)) {
      try {
        doc = parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        doc = {};
      }
    }

    const storage =
      doc.storage && typeof doc.storage === 'object'
        ? (doc.storage as Record<string, unknown>)
        : ((doc.storage = {}) as Record<string, unknown>);
    storage.database_path = config.databasePath;

    writeFileAtomic.sync(cfgPath, stringify(doc as Parameters<typeof stringify>[0]), { mode: 0o600 });
    logger.info('config.toml storage.database_path updated', { databasePath: config.databasePath }, LogComponent.ConfigManager);
    return true;
  } catch (error) {
    logger.error('Failed to write database path to config.toml', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.ConfigManager);
    return false;
  }
}

/**
 * Resolve the database path with full fallback chain:
 * 1. config.toml `storage.database_path` (if set and valid)
 * 2. Legacy duya-config.json (migration)
 * 3. Default path (userData/databases/duya-main.db)
 *
 * Also handles backward compatibility for old duya.db filename.
 */
export function resolveDatabasePath(): { dbPath: string; needsBootWrite: boolean; needsDbRename: boolean } {
  // Step 1: Check config.toml storage.database_path
  const configured = resolveDatabasePathFromConfigToml();
  if (configured && configured.trim()) {
    const dbPath = configured;

    // Handle backward compatibility: if path ends with old filename, check for rename
    const oldDbPath = dbPath.replace('duya-main.db', 'duya.db');
    const needsDbRename = !fs.existsSync(dbPath) && fs.existsSync(oldDbPath);

    return { dbPath, needsBootWrite: false, needsDbRename };
  }

  // Step 2: Check legacy config
  const legacyPath = migrateFromLegacyConfig();
  if (legacyPath) {
    const oldDbPath = legacyPath.replace('duya-main.db', 'duya.db');
    const needsDbRename = !fs.existsSync(legacyPath) && fs.existsSync(oldDbPath);
    return { dbPath: legacyPath, needsBootWrite: true, needsDbRename };
  }

  // Step 3: Default path
  const defaultPath = getDefaultDatabasePath();

  // Check if old duya.db exists at default location
  const oldDefaultPath = path.join(getDefaultDatabaseDir(), 'duya.db');
  const needsDbRename = !fs.existsSync(defaultPath) && fs.existsSync(oldDefaultPath);

  return { dbPath: defaultPath, needsBootWrite: true, needsDbRename };
}

/**
 * Validate that the database path is accessible.
 * Returns { valid: true } if the path is usable,
 * or { valid: false, reason: string } if not.
 */
export function validateDatabasePath(dbPath: string): { valid: boolean; reason?: string } {
  try {
    const dbDir = path.dirname(dbPath);

    // Check if directory exists or can be created
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch {
        return { valid: false, reason: `Cannot create directory: ${dbDir}` };
      }
    }

    // Check write permission on directory
    try {
      fs.accessSync(dbDir, fs.constants.W_OK | fs.constants.R_OK);
    } catch {
      return { valid: false, reason: `No read/write permission on: ${dbDir}` };
    }

    // If database file exists, check it's readable
    if (fs.existsSync(dbPath)) {
      try {
        fs.accessSync(dbPath, fs.constants.R_OK);
      } catch {
        return { valid: false, reason: `Database file exists but is not readable: ${dbPath}` };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Validation error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Rename old duya.db to duya-main.db (backward compatibility).
 * Also renames .db-wal and .db-shm files if they exist.
 */
export function renameLegacyDatabase(dbPath: string): boolean {
  const oldDbPath = dbPath.replace('duya-main.db', 'duya.db');

  if (!fs.existsSync(oldDbPath) || fs.existsSync(dbPath)) {
    return false;
  }

  try {
    fs.renameSync(oldDbPath, dbPath);
    logger.info('Renamed database', { oldDbPath, newDbPath: dbPath }, LogComponent.ConfigManager);

    // Rename WAL and SHM files
    const oldWal = oldDbPath + '-wal';
    const newWal = dbPath + '-wal';
    if (fs.existsSync(oldWal) && !fs.existsSync(newWal)) {
      fs.renameSync(oldWal, newWal);
    }

    const oldShm = oldDbPath + '-shm';
    const newShm = dbPath + '-shm';
    if (fs.existsSync(oldShm) && !fs.existsSync(newShm)) {
      fs.renameSync(oldShm, newShm);
    }

    return true;
  } catch (error) {
    logger.error('Failed to rename legacy database', error instanceof Error ? error : new Error(String(error)), { oldDbPath, dbPath }, LogComponent.ConfigManager);
    return false;
  }
}

/**
 * Initialize config.toml if needed (first run or after migration).
 * Ensures the database directory exists.
 */
export function initBootConfig(dbPath: string): void {
  ensureDatabaseDir(dbPath);

  const bootConfig = readBootConfig();
  if (!bootConfig || bootConfig.databasePath !== dbPath) {
    writeBootConfig({ databasePath: dbPath });
  }
}

/**
 * Get the current database path from config.toml.
 * If not configured, returns the default path.
 * Used by other modules that need to know the DB location.
 */
export function getDatabasePath(): string {
  const { dbPath } = resolveDatabasePath();
  return dbPath;
}

/**
 * Update the database path in config.toml (used during migration workflow).
 * This is the ONLY way to change where the database is stored.
 */
export function updateDatabasePath(newDbPath: string): boolean {
  const validation = validateDatabasePath(newDbPath);
  if (!validation.valid) {
    logger.error('Invalid database path', new Error(validation.reason), { newDbPath }, LogComponent.ConfigManager);
    return false;
  }

  return writeBootConfig({ databasePath: newDbPath });
}

// ============================================================
// Core database path resolution (plan 326-328)
// ============================================================

/**
 * Resolve the core database path (`duya-core.db`).
 * Same directory as the legacy `duya-main.db`; namespace isolation is
 * inherited from the userData path (test mode sets a per-namespace
 * userData, so no explicit suffix is needed on the filename).
 */
export function resolveCoreDatabasePath(): string {
  const { dbPath } = resolveDatabasePath();
  return path.join(path.dirname(dbPath), 'duya-core.db');
}

/**
 * Read a single `[storage]` root key from config.toml. Empty string = unset.
 * Kept local (rather than going through ConfigStore) so this early "compass"
 * module stays lightweight and never introduces a dependency cycle.
 */
function readStorageRoot(key: 'rollout_root' | 'attachments_root'): string {
  const cfgPath = resolveConfigTomlPath();
  try {
    if (!fs.existsSync(cfgPath)) return '';
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const doc = parse(raw) as { storage?: Record<string, string> };
    return doc?.storage?.[key] ?? '';
  } catch {
    return '';
  }
}

/**
 * Resolve the rollout root directory for MessageLog JSONL files.
 *
 * Mirrors Codex's `~/.codex/sessions/` layout: rollout files live under
 * `~/.duya/sessions/<YYYY>/<MM>/<DD>/...` (MessageLog.resolvePath appends the
 * `sessions/<YYYY>/<MM>/<DD>/...` subpath on top of this root, so this root
 * must NOT include `sessions` itself, or the rollout path would duplicate the
 * folder). The `[storage] rollout_root` config overrides the default. In test
 * mode (`DUYA_TEST=1`), a `test-namespaces/<ns>` suffix keeps each Playwright
 * namespace fully isolated from the real user data.
 *
 * Test-mode detection is inlined (rather than importing `../core/bootstrap`)
 * so this early "compass" module stays dependency-free and never pulls in the
 * logger/bootstrap init chain.
 */
export function resolveRolloutRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = readTestNamespace();
    if (ns) return path.join(base, 'test-namespaces', ns);
  }
  const configured = readStorageRoot('rollout_root');
  return configured && configured.trim() ? configured : base;
}

/**
 * Parse `--duya-namespace=<name>` from argv (mirrors `getTestNamespace` in
 * `../core/bootstrap`, kept here to avoid a module dependency). Returns null
 * when absent or invalid.
 */
function readTestNamespace(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--duya-namespace=')) {
      const ns = arg.slice('--duya-namespace='.length);
      return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
    }
  }
  const idx = process.argv.indexOf('--duya-namespace');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const ns = process.argv[idx + 1];
    return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
  }
  return null;
}

/**
 * Resolve the root directory for file-backed attachments (plan 332 Phase 2).
 *
 * Mirrors Codex's `~/.codex/attachments/<uuid>/` layout: payload files live
 * under `~/.duya/attachments/<id>/<filename>`. The `[storage] attachments_root`
 * config overrides the default root. In test mode a `test-namespaces/<ns>`
 * suffix keeps each Playwright namespace isolated from the real user data —
 * the same policy as `resolveRolloutRoot`.
 */
export function resolveAttachmentsRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = readTestNamespace();
    if (ns) return path.join(base, 'test-namespaces', ns, 'attachments');
  }
  const configured = readStorageRoot('attachments_root');
  return configured && configured.trim() ? configured : path.join(base, 'attachments');
}