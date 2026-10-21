import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteCtor = typeof BetterSqlite3;

const requireFromData = createRequire(import.meta.url);

export interface OpenSqliteDatabaseOptions {
  filename: string;
  /** Inject the Electron-packaged native binding or a test constructor. */
  sqlite?: SqliteCtor;
}

/** Open a WAL-backed SQLite handle with the shared Duya connection settings. */
export function openSqliteDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
  fs.mkdirSync(path.dirname(options.filename), { recursive: true });
  const Sqlite = options.sqlite ?? (requireFromData('better-sqlite3') as SqliteCtor);
  const db = new Sqlite(options.filename);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
