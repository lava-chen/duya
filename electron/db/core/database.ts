/**
 * CoreDatabase — connection lifecycle + migration runner for the new
 * `duya-core.db` store. Replaces the schema-growth model of the legacy
 * `electron/db/schema.ts` with a migration-from-id-1 discipline where each
 * aggregate class owns its own `static migrations` list.
 *
 * The shared `startWalCheckpoint` helper is also exported for the legacy
 * `connection.ts` to reuse, so both databases run the same 60s PASSIVE
 * checkpoint + close-time TRUNCATE checkpoint.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { getLogger, LogComponent } from '../../logging/logger';

// electron is CommonJS (tsconfig module=CommonJS), so createRequire(__filename)
// is the safe equivalent of createRequire(import.meta.url). Aligns with the
// legacy `electron/db/connection.ts:86` loading pattern.
export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteCtor = typeof BetterSqlite3;

export interface Migration {
  id: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

const CHECKPOINT_INTERVAL_MS = 60_000;
const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * Start a 60s PASSIVE WAL checkpoint scheduler on the given database.
 * Returns a stop function that clears the timer and runs a final TRUNCATE
 * checkpoint. The stop function is idempotent.
 *
 * Shared between `CoreDatabase` and the legacy `connection.ts` so both
 * databases use the same checkpoint discipline.
 */
export function startWalCheckpoint(db: SqliteDatabase): () => void {
  const logger = getLogger();
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // best-effort
    }
  }, CHECKPOINT_INTERVAL_MS);

  logger.info('WAL checkpoint scheduler started', { intervalMs: CHECKPOINT_INTERVAL_MS }, LogComponent.DB);

  let stopped = false;
  return function stopWalCheckpoint(): void {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // best-effort
    }
  };
}

export interface CoreDatabaseOptions {
  filename: string;
  sqlite?: SqliteCtor;
  migrations: Migration[];
}

export class CoreDatabase {
  readonly db: SqliteDatabase;
  private readonly stopCheckpoint: () => void;

  constructor(options: CoreDatabaseOptions) {
    const Ctor = options.sqlite ?? (createRequire(__filename)('better-sqlite3') as SqliteCtor);
    fs.mkdirSync(path.dirname(options.filename), { recursive: true });
    this.db = new Ctor(options.filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.ensureMeta();
    this.runMigrations(options.migrations);
    this.stopCheckpoint = startWalCheckpoint(this.db);
  }

  get schemaVersion(): number {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    this.stopCheckpoint();
    this.db.close();
  }

  private ensureMeta(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private runMigrations(migrations: Migration[]): void {
    const logger = getLogger();
    const sorted = [...migrations].sort((a, b) => a.id - b.id);
    const current = this.schemaVersion;
    for (const migration of sorted) {
      if (migration.id <= current) continue;
      logger.info(`Running core migration ${migration.id}: ${migration.name}`, undefined, LogComponent.DBMigration);
      const txn = this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(SCHEMA_VERSION_KEY, String(migration.id));
      });
      try {
        txn();
        logger.info(`Core migration ${migration.id} completed`, undefined, LogComponent.DBMigration);
      } catch (error) {
        logger.error(
          `Core migration ${migration.id} failed`,
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          LogComponent.DBMigration,
        );
        throw error;
      }
    }
  }
}
