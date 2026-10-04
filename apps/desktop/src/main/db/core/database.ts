/**
 * CoreDatabase — connection lifecycle + migration runner for the new
 * `duya-core.db` store. Replaces the schema-growth model of the legacy
 * `apps/desktop/src/main/db/schema.ts` with a migration-from-id-1 discipline where each
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
// legacy `apps/desktop/src/main/db/connection.ts:86` loading pattern.
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
 * JSON array of the migration ids this database has already been offered.
 * `schema_version` alone cannot tell "already applied" from "lost", because
 * every aggregate shares the one counter; this key records the set so a
 * migration authored at an id the counter has already passed is reported
 * instead of skipped in silence.
 */
const APPLIED_IDS_KEY = 'applied_migration_ids';

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

  private readAppliedIds(): Set<number> | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(APPLIED_IDS_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const ids: unknown[] = parsed;
    return new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)));
  }

  private recordAppliedIds(ids: Set<number>): void {
    const value = JSON.stringify([...ids].sort((a, b) => a - b));
    const existing = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(APPLIED_IDS_KEY) as { value?: string } | undefined;
    if (existing?.value === value) return;
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(APPLIED_IDS_KEY, value);
  }

  private runMigrations(migrations: Migration[]): void {
    const logger = getLogger();
    const sorted = [...migrations].sort((a, b) => a.id - b.id);

    // Every aggregate numbers its own migrations from 1, but they all share
    // one `schema_version` counter. Two migrations with the same id therefore
    // mean the second is silently skipped forever by the `id <= current`
    // guard below (exactly how `message_search` and
    // `session_runtime_locks.origin` went missing). Fail loud in the log
    // instead of shipping another silent data bug.
    const seenIds = new Map<number, string>();
    for (const migration of sorted) {
      const prior = seenIds.get(migration.id);
      if (prior !== undefined) {
        logger.error(
          `Duplicate core migration id ${migration.id}: "${prior}" vs "${migration.name}" — the later one will never run`,
          undefined,
          undefined,
          LogComponent.DBMigration,
        );
      } else {
        seenIds.set(migration.id, migration.name);
      }
    }

    const current = this.schemaVersion;
    // Startup assertion: every migration this DB was not already offered must
    // have `id > current`, otherwise the shared-counter guard below skips it
    // forever. The registry has permanent gaps (3, 19, 20, 21, 27), so a
    // migration later authored at one of those ids lands below the counter and
    // is dropped with no trace at all — the same silent loss that took
    // `session_runtime_locks.origin` and `message_search`. The recorded id set
    // is what keeps this precise: without it every already-applied migration
    // looks like a lost one and this would fire on every boot. A DB predating
    // the key is presumed to have applied everything at or below `current`, so
    // its first boot only establishes the baseline.
    const applied = this.readAppliedIds() ?? new Set<number>(
      sorted.filter((migration) => migration.id <= current).map((migration) => migration.id),
    );
    for (const migration of sorted) {
      if (migration.id <= current) {
        if (!applied.has(migration.id)) {
          logger.error(
            `Core migration ${migration.id} (${migration.name}) was never applied but schema_version is already ${current} — it can never run. Re-number it above ${current}.`,
            undefined,
            undefined,
            LogComponent.DBMigration,
          );
          applied.add(migration.id);
        }
        continue;
      }
      logger.info(`Running core migration ${migration.id}: ${migration.name}`, undefined, LogComponent.DBMigration);
      const txn = this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(SCHEMA_VERSION_KEY, String(migration.id));
      });
      try {
        txn();
        applied.add(migration.id);
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
    this.recordAppliedIds(applied);
  }
}
