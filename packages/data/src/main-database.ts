import { startWalCheckpoint, type DataLogger, type SqliteCtor, type SqliteDatabase } from './core-database.js';
import { initializeSchema, selfCheckAndRepairSchema, type MainSchemaPorts } from './main-schema.js';
import { openSqliteDatabase } from './sqlite-connection.js';

export interface MainDatabaseOptions {
  filename: string;
  sqlite?: SqliteCtor;
  ports: MainSchemaPorts;
  logger?: DataLogger;
}

/** Own the main application database connection, schema, and checkpoint lifecycle. */
export class MainDatabase {
  readonly db: SqliteDatabase;
  private stopCheckpointFn: (() => void) | null = null;
  private closed = false;

  constructor(options: MainDatabaseOptions) {
    const db = openSqliteDatabase({
      filename: options.filename,
      ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    });
    this.db = db;

    try {
      initializeSchema(db, options.ports, options.logger);
      selfCheckAndRepairSchema(db, options.logger);
      this.stopCheckpointFn = startWalCheckpoint(db, options.logger);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Stop periodic checkpoints and run the final WAL flush without closing the handle. */
  stopWalCheckpoint(): void {
    this.stopCheckpointFn?.();
    this.stopCheckpointFn = null;
  }

  /** Stop checkpointing and close the owned SQLite handle. Safe to call repeatedly. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWalCheckpoint();
    this.db.close();
  }
}
