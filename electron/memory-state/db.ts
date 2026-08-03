import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getLogger, LogComponent } from '../logging/logger';
import { resolveMemoryDbPath } from './path';
import { runMigrations } from './migrations';

/**
 * Memory state DB lifecycle.
 *
 * Singleton per process. `bootstrap()` is idempotent within a process
 * (returns the cached instance). `closeDb()` tears down for graceful
 * restart; calling `bootstrap()` again reopens.
 *
 * Cross-process correctness (per Plan 301 D2):
 *   - Electron Main is the only production writer.
 *   - Two processes opening the same WAL DB file is supported by SQLite.
 *   - Each process sees its own write; reads from another process
 *     become visible after the writer commits.
 *   - Migration application uses `BEGIN IMMEDIATE` (see migrations/index.ts)
 *     so racing bootstraps serialize correctly.
 *
 * Plan 305 wires this into the memory-worker; until then there are no
 * production callers (shadow mode).
 */

type BetterSqlite3Ctor = new (filename: string) => Database;

let db: Database | null = null;
let ctorCache: BetterSqlite3Ctor | null = null;

/**
 * Load the better-sqlite3 constructor.
 *
 * Respects `DUYA_BETTER_SQLITE3_PATH` for packaged builds (the same
 * env var the agent subprocess uses). Plan 305 will wire the
 * `<resources>/better-sqlite3/` native binding path when it connects
 * the worker to the Electron main process.
 */
function loadCtor(): BetterSqlite3Ctor {
  if (ctorCache) return ctorCache;
  const customPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  let ctor: BetterSqlite3Ctor;
  if (customPath) {
    // createRequire from the custom package's package.json so the
    // native binding resolves correctly in packaged builds.
    const { createRequire } = require('module');
    const req = createRequire(path.join(customPath, 'package.json'));
    ctor = req('better-sqlite3');
  } else {
    ctor = require('better-sqlite3');
  }
  ctorCache = ctor;
  return ctor;
}

export interface BootstrapOptions {
  /** Database directory resolved from boot.json (required — no fallback). */
  bootJsonDatabaseDir: string;
  /**
   * Optional constructor injection for tests. Production callers should
   * omit this so the loader respects `DUYA_BETTER_SQLITE3_PATH`.
   */
  betterSqlite3Ctor?: BetterSqlite3Ctor;
}

/**
 * Open the memory-state DB and apply pending migrations.
 *
 * Idempotent within a process: re-calling with the same options
 * returns the cached instance. After `closeDb()`, re-calling
 * `bootstrap()` reopens.
 */
export function bootstrap(opts: BootstrapOptions): Database {
  const logger = getLogger();
  if (db) {
    return db;
  }

  const Ctor = opts.betterSqlite3Ctor ?? loadCtor();
  const dbPath = resolveMemoryDbPath({ bootJsonDatabaseDir: opts.bootJsonDatabaseDir });

  // Ensure the parent directory exists (matches the main DB's behavior).
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Ctor(dbPath);

  // PRAGMAs — mirror the main DB (electron/db/connection.ts) plus
  // temp_store=MEMORY for the shadow-mode workload.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  logger.warn(
    'memory-state: DB opened',
    { dbPath, journalMode: db.pragma('journal_mode', { simple: true }) },
    LogComponent.DB
  );

  runMigrations(db);

  return db;
}

/**
 * Get the open DB instance. Throws if `bootstrap()` has not been called.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error('memory-state: DB not bootstrapped. Call bootstrap() first.');
  }
  return db;
}

/**
 * Close the DB and invalidate the singleton. Safe to call multiple
 * times — subsequent calls are no-ops. `bootstrap()` can reopen.
 */
export function closeDb(): void {
  if (db) {
    const logger = getLogger();
    try {
      db.close();
      logger.warn('memory-state: DB closed', undefined, LogComponent.DB);
    } catch (err) {
      logger.warn(
        'memory-state: error closing DB',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB
      );
    } finally {
      db = null;
    }
  }
}

/**
 * Test helper: check whether a DB instance is currently open.
 * Production code should use `getDb()` (which throws) or `bootstrap()`.
 */
export function isOpen(): boolean {
  return db !== null;
}
