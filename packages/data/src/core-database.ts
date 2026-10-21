import { openSqliteDatabase } from './sqlite-connection.js';
import type { SqliteCtor, SqliteDatabase } from './sqlite-connection.js';

export type { SqliteCtor, SqliteDatabase } from './sqlite-connection.js';

export interface Migration {
  id: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

export interface DataLogEvent {
  level: 'info' | 'warn' | 'error';
  category: 'database' | 'database-migration';
  message: string;
  error?: Error;
  data?: Record<string, unknown>;
}

export type DataLogger = (event: DataLogEvent) => void;

const CHECKPOINT_INTERVAL_MS = 60_000;
const SCHEMA_VERSION_KEY = 'schema_version';

/** Start a periodic WAL checkpoint and return an idempotent close-time flush. */
export function startWalCheckpoint(
  db: SqliteDatabase,
  logger?: DataLogger,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // Checkpointing is best-effort while the connection remains available.
    }
  }, CHECKPOINT_INTERVAL_MS);

  logger?.({
    level: 'info',
    category: 'database',
    message: 'WAL checkpoint scheduler started',
    data: { intervalMs: CHECKPOINT_INTERVAL_MS },
  });

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
      // The caller is closing the connection; a final checkpoint is best-effort.
    }
  };
}

export interface CoreDatabaseOptions {
  filename: string;
  sqlite?: SqliteCtor;
  migrations: Migration[];
  logger?: DataLogger;
}

/** Electron-free connection and migration owner for `duya-core.db`. */
export class CoreDatabase {
  readonly db: SqliteDatabase;
  private readonly stopCheckpoint: () => void;

  constructor(options: CoreDatabaseOptions) {
    this.db = openSqliteDatabase(options);
    this.ensureMeta();
    this.runMigrations(options.migrations, options.logger);
    this.stopCheckpoint = startWalCheckpoint(this.db, options.logger);
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

  private runMigrations(migrations: Migration[], logger?: DataLogger): void {
    const sorted = [...migrations].sort((a, b) => a.id - b.id);
    const seenIds = new Map<number, string>();
    for (const migration of sorted) {
      const prior = seenIds.get(migration.id);
      if (prior !== undefined) {
        logger?.({
          level: 'error',
          category: 'database-migration',
          message: `Duplicate core migration id ${migration.id}: "${prior}" vs "${migration.name}" — the later one will never run`,
        });
      } else {
        seenIds.set(migration.id, migration.name);
      }
    }

    const current = this.schemaVersion;
    for (const migration of sorted) {
      if (migration.id <= current) continue;
      logger?.({
        level: 'info',
        category: 'database-migration',
        message: `Running core migration ${migration.id}: ${migration.name}`,
      });
      const txn = this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(SCHEMA_VERSION_KEY, String(migration.id));
      });
      try {
        txn();
        logger?.({
          level: 'info',
          category: 'database-migration',
          message: `Core migration ${migration.id} completed`,
        });
      } catch (error) {
        const migrationError = error instanceof Error ? error : new Error(String(error));
        logger?.({
          level: 'error',
          category: 'database-migration',
          message: `Core migration ${migration.id} failed`,
          error: migrationError,
        });
        throw error;
      }
    }
  }
}
