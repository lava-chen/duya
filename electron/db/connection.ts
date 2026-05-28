/**
 * connection.ts - Database lifecycle management (The Ledger)
 *
 * Extracted from db-handlers.ts. Handles the singleton SQLite connection:
 * loading the native module, initializing the database, Safe Mode detection,
 * statistics, and size warnings.
 *
 * Database file: duya-main.db (path resolved from boot.json)
 * Uses WAL mode for read/write concurrency.
 * Safe Mode: If database path is invalid, returns error instead of crashing.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import {
  resolveDatabasePath,
  validateDatabasePath,
  initBootConfig,
  renameLegacyDatabase,
} from '../config/boot-config';
import { getLogger, LogComponent } from '../logging/logger';
import { initializeSchema, selfCheckAndRepairSchema } from './schema';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

let BetterSqlite3Ctor: typeof import('better-sqlite3');
let db: BetterSqlite3 | null = null;
let safeModeReason: string | null = null;
let walCheckpointer: ReturnType<typeof setInterval> | null = null;

// Module-level logger instance for database operations
const dbLogger = getLogger();

function startWalCheckpoint(): void {
  if (walCheckpointer) return;

  const CHECKPOINT_INTERVAL_MS = 60000;

  walCheckpointer = setInterval(() => {
    if (!db) return;
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // best-effort
    }
  }, CHECKPOINT_INTERVAL_MS);

  dbLogger.info('WAL checkpoint scheduler started', { intervalMs: CHECKPOINT_INTERVAL_MS }, LogComponent.DB);
}

export function stopWalCheckpoint(): void {
  if (walCheckpointer) {
    clearInterval(walCheckpointer);
    walCheckpointer = null;

    if (db) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort
      }
    }
  }
}

function loadBetterSqlite3(): typeof import('better-sqlite3') {
  const logger = getLogger();
  if (app.isPackaged) {
    const betterSqlite3Path = path.join(process.resourcesPath, 'better-sqlite3');
    const nativeBindingPath = path.join(betterSqlite3Path, 'build', 'Release', 'better_sqlite3.node');

    logger.info('Loading better-sqlite3', { path: betterSqlite3Path, nativeBinding: nativeBindingPath }, LogComponent.DB);

    // Load from unpacked extraResources path directly.
    // Requiring by package name here fails in production because there is no
    // node_modules tree under resources/better-sqlite3.
    const requireFromPackage = createRequire(path.join(betterSqlite3Path, 'package.json'));
    const BetterSqlite3 = requireFromPackage('./');

    BetterSqlite3Ctor = class extends BetterSqlite3 {
      constructor(filename: string) {
        super(filename, { nativeBinding: nativeBindingPath });
      }
    } as unknown as typeof import('better-sqlite3');

    logger.info('better-sqlite3 constructor loaded with custom nativeBinding', undefined, LogComponent.DB);
    return BetterSqlite3Ctor;
  } else {
    BetterSqlite3Ctor = require('better-sqlite3');
    return BetterSqlite3Ctor;
  }
}

// ============================================================
// Database Initialization (with Safe Mode support)
// ============================================================

export interface DbInitResult {
  success: boolean;
  dbPath?: string;
  error?: string;
  safeMode?: boolean;
}

/**
 * Initialize database using path from boot.json.
 * Implements Defense 2 (Safe Mode): if DB path is invalid, returns error
 * instead of crashing the app.
 */
export function initDatabaseFromBoot(): DbInitResult {
  const logger = getLogger();
  if (db) {
    return { success: true, dbPath: getDatabasePath() };
  }

  // Step 1: Resolve database path from boot.json
  const { dbPath, needsBootWrite, needsDbRename } = resolveDatabasePath();
  logger.info('Resolved database path', { dbPath }, LogComponent.DB);

  // Step 2: Handle legacy duya.db -> duya-main.db rename
  if (needsDbRename) {
    const renamed = renameLegacyDatabase(dbPath);
    if (renamed) {
      logger.info('Renamed legacy database file', undefined, LogComponent.DB);
    }
  }

  // Step 3: Validate the database path
  const validation = validateDatabasePath(dbPath);
  if (!validation.valid) {
    logger.error('Database path validation failed', new Error(validation.reason), { dbPath }, LogComponent.DB);
    safeModeReason = validation.reason ?? null;
    return {
      success: false,
      dbPath,
      error: validation.reason,
      safeMode: true,
    };
  }

  // Step 4: Write boot.json if needed (first run or migration)
  if (needsBootWrite) {
    initBootConfig(dbPath);
  }

  // Step 5: Initialize the database
  try {
    if (!BetterSqlite3Ctor) {
      BetterSqlite3Ctor = loadBetterSqlite3();
    }

    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      logger.info('Creating directory', { dbDir }, LogComponent.DB);
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new BetterSqlite3Ctor(dbPath);
    logger.info('Database opened successfully', { dbPath }, LogComponent.DB);

    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    initializeSchema(db);
    selfCheckAndRepairSchema(db);

    startWalCheckpoint();

    safeModeReason = null;
    return { success: true, dbPath };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to initialize database', error instanceof Error ? error : new Error(errorMsg), { dbPath }, LogComponent.DB);
    safeModeReason = errorMsg;
    return {
      success: false,
      dbPath,
      error: errorMsg,
      safeMode: true,
    };
  }
}

/**
 * Legacy initDatabase function - kept for backward compatibility.
 * Now delegates to initDatabaseFromBoot().
 */
export function initDatabase(dbDir: string): BetterSqlite3 {
  const logger = getLogger();
  if (db) return db;

  if (!BetterSqlite3Ctor) {
    BetterSqlite3Ctor = loadBetterSqlite3();
  }

  const dbPath = path.join(dbDir, 'duya-main.db');

  // Also check for old duya.db
  const oldDbPath = path.join(dbDir, 'duya.db');
  if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
    fs.renameSync(oldDbPath, dbPath);
    const oldWal = oldDbPath + '-wal';
    const newWal = dbPath + '-wal';
    if (fs.existsSync(oldWal)) fs.renameSync(oldWal, newWal);
    const oldShm = oldDbPath + '-shm';
    const newShm = dbPath + '-shm';
    if (fs.existsSync(oldShm)) fs.renameSync(oldShm, newShm);
    logger.info('Renamed legacy duya.db to duya-main.db', undefined, LogComponent.DB);
  }

  logger.info('Initializing database', { dbPath }, LogComponent.DB);

  if (!fs.existsSync(dbDir)) {
    logger.info('Creating directory', { dbDir }, LogComponent.DB);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new BetterSqlite3Ctor(dbPath);
  logger.info('Database opened successfully', { dbPath }, LogComponent.DB);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);
  selfCheckAndRepairSchema(db);

  startWalCheckpoint();

  return db;
}

export function getDatabase(): BetterSqlite3 | null {
  return db;
}

export function getDatabasePath(): string {
  if (db) {
    return db.name;
  }
  return resolveDatabasePath().dbPath;
}

export function isSafeMode(): boolean {
  return safeModeReason !== null;
}

export function getSafeModeReason(): string | null {
  return safeModeReason;
}

export interface DatabaseStats {
  /** Database file path */
  path: string;
  /** File size in bytes */
  sizeBytes: number;
  /** File size in human-readable format */
  sizeFormatted: string;
  /** Total message count */
  messageCount: number;
  /** Total session count */
  sessionCount: number;
  /** WAL file size in bytes (0 if WAL not present) */
  walSizeBytes: number;
}

/**
 * Get database file size and message statistics.
 * Returns null if database is not initialized.
 */
export function getDatabaseStats(): DatabaseStats | null {
  if (!db) return null;

  const dbPath = db.name;

  let sizeBytes = 0;
  let walSizeBytes = 0;

  try {
    const stat = fs.statSync(dbPath);
    sizeBytes = stat.size;
  } catch {
    // File may not exist yet
  }

  try {
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      walSizeBytes = fs.statSync(walPath).size;
    }
  } catch {
    // WAL file may not exist
  }

  let messageCount = 0;
  let sessionCount = 0;

  try {
    const messageRow = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    messageCount = messageRow?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  try {
    const sessionRow = db.prepare('SELECT COUNT(*) as count FROM chat_sessions').get() as { count: number };
    sessionCount = sessionRow?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  const totalSize = sizeBytes + walSizeBytes;

  return {
    path: dbPath,
    sizeBytes: totalSize,
    sizeFormatted: formatBytes(totalSize),
    messageCount,
    sessionCount,
    walSizeBytes,
  };
}

/**
 * Check if database size exceeds the recommended threshold.
 * Returns a warning message if threshold exceeded, null otherwise.
 */
export function checkDatabaseSizeWarning(): string | null {
  const stats = getDatabaseStats();
  if (!stats) return null;

  const SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100 MB

  if (stats.sizeBytes > SIZE_WARNING_THRESHOLD) {
    return `Database size (${stats.sizeFormatted}) exceeds 100MB. Consider running VACUUM to reclaim space. Messages: ${stats.messageCount}, Sessions: ${stats.sessionCount}`;
  }

  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(1)} ${units[i]}`;
}

// ============================================================
// Re-exports for module access
// ============================================================

export { db, safeModeReason };

export function getDb(): BetterSqlite3 | null {
  return db;
}

export function setDb(d: BetterSqlite3 | null): void {
  db = d;
}

export function getSafeModeReasonValue(): string | null {
  return safeModeReason;
}

export function setSafeModeReason(reason: string | null): void {
  safeModeReason = reason;
}
