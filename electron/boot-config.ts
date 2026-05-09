/**
 * boot-config.ts - Boot Configuration Manager (The Compass)
 *
 * Manages /config/boot.json - the single source of truth for database path.
 * This file is read FIRST during app startup, before any other initialization.
 *
 * Design principles:
 * - Plaintext (must be readable at the earliest stage of app startup)
 * - Atomic writes (prevent corruption on power loss)
 * - Minimal content (only databasePath)
 * - Backward compatible (migrates from old duya-config.json format)
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import writeFileAtomic from 'write-file-atomic';

export interface BootConfig {
  databasePath: string;
}

const BOOT_CONFIG_VERSION = 1;

interface BootConfigFile extends BootConfig {
  _version: number;
}

function getConfigDir(): string {
  return path.join(app.getPath('userData'), 'config');
}

function getBootConfigPath(): string {
  return path.join(getConfigDir(), 'boot.json');
}

function getDefaultDatabaseDir(): string {
  return path.join(app.getPath('userData'), 'databases');
}

function getDefaultDatabasePath(): string {
  return path.join(getDefaultDatabaseDir(), 'duya-main.db');
}

function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function ensureDatabaseDir(dbPath: string): void {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * Migrate from old duya-config.json format to new boot.json.
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
          console.log('[BootConfig] Migrating legacy config from:', legacyPath);
          const oldDbPath = config.databasePath.trim();
          const newDbPath = path.join(oldDbPath, 'duya-main.db');
          if (fs.existsSync(path.join(oldDbPath, 'duya.db')) && !fs.existsSync(newDbPath)) {
            console.log('[BootConfig] Legacy database file found, will be renamed during DB init');
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
 * Read boot.json synchronously.
 * This is called at the very start of app lifecycle - must be fast and reliable.
 * Returns the databasePath, or undefined if boot.json doesn't exist yet.
 */
export function readBootConfig(): BootConfig | undefined {
  const bootPath = getBootConfigPath();

  try {
    if (fs.existsSync(bootPath)) {
      const content = fs.readFileSync(bootPath, 'utf-8');
      const config = JSON.parse(content) as BootConfigFile;

      if (config.databasePath && typeof config.databasePath === 'string') {
        return { databasePath: config.databasePath };
      }
    }
  } catch (error) {
    console.error('[BootConfig] Failed to read boot.json:', error);
  }

  return undefined;
}

/**
 * Write boot.json atomically.
 * Uses write-file-atomic to prevent corruption on power loss.
 */
export function writeBootConfig(config: BootConfig): boolean {
  try {
    ensureConfigDir();

    const data: BootConfigFile = {
      _version: BOOT_CONFIG_VERSION,
      databasePath: config.databasePath,
    };

    writeFileAtomic.sync(getBootConfigPath(), JSON.stringify(data, null, 2));
    console.log('[BootConfig] boot.json updated:', config.databasePath);
    return true;
  } catch (error) {
    console.error('[BootConfig] Failed to write boot.json:', error);
    return false;
  }
}

/**
 * Resolve the database path with full fallback chain:
 * 1. boot.json (if exists and valid)
 * 2. Legacy duya-config.json (migration)
 * 3. Default path (userData/databases/duya-main.db)
 *
 * Also handles backward compatibility for old duya.db filename.
 */
export function resolveDatabasePath(): { dbPath: string; needsBootWrite: boolean; needsDbRename: boolean } {
  // Step 1: Check boot.json
  const bootConfig = readBootConfig();
  if (bootConfig?.databasePath) {
    const dbPath = bootConfig.databasePath;

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
    console.log('[BootConfig] Renamed database:', oldDbPath, '->', dbPath);

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
    console.error('[BootConfig] Failed to rename legacy database:', error);
    return false;
  }
}

/**
 * Initialize boot.json if needed (first run or after migration).
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
 * Get the current database path from boot.json.
 * If boot.json doesn't exist, returns the default path.
 * Used by other modules that need to know the DB location.
 */
export function getDatabasePath(): string {
  const { dbPath } = resolveDatabasePath();
  return dbPath;
}

/**
 * Update the database path in boot.json (used during migration workflow).
 * This is the ONLY way to change where the database is stored.
 */
export function updateDatabasePath(newDbPath: string): boolean {
  const validation = validateDatabasePath(newDbPath);
  if (!validation.valid) {
    console.error('[BootConfig] Invalid database path:', validation.reason);
    return false;
  }

  return writeBootConfig({ databasePath: newDbPath });
}
