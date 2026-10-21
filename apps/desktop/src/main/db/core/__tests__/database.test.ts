import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDatabase, startWalCheckpoint, type Migration } from '../database';

describe('CoreDatabase', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-db-test-'));
    dbPath = path.join(tempDir, 'core.db');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('opens the database with WAL mode and required pragmas', () => {
    const core = new CoreDatabase({ filename: dbPath, migrations: [] });
    const journalMode = core.db.pragma('journal_mode', { simple: true });
    const busyTimeout = core.db.pragma('busy_timeout', { simple: true });
    const foreignKeys = core.db.pragma('foreign_keys', { simple: true });
    expect(journalMode).toBe('wal');
    expect(busyTimeout).toBe(5000);
    expect(foreignKeys).toBe(1); // better-sqlite3 returns 1/0 for ON/OFF
    core.close();
  });

  it('creates the meta table on construction', () => {
    const core = new CoreDatabase({ filename: dbPath, migrations: [] });
    const tables = core.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('meta');
    core.close();
  });

  it('runs migrations in id order and advances schema_version', () => {
    const m1: Migration = {
      id: 1,
      name: 'create_t1',
      up: (db) => db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)'),
    };
    const m2: Migration = {
      id: 2,
      name: 'create_t2',
      up: (db) => db.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY)'),
    };
    const core = new CoreDatabase({ filename: dbPath, migrations: [m2, m1] });
    expect(core.schemaVersion).toBe(2);
    const tables = core.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('t1');
    expect(names).toContain('t2');
    core.close();
  });

  it('does not re-run migrations on re-construction', () => {
    const m1: Migration = {
      id: 1,
      name: 'create_t1',
      up: (db) => db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)'),
    };
    const core1 = new CoreDatabase({ filename: dbPath, migrations: [m1] });
    core1.close();

    // Re-open with a migration that would fail if re-run (CREATE without IF NOT EXISTS)
    const core2 = new CoreDatabase({ filename: dbPath, migrations: [m1] });
    expect(core2.schemaVersion).toBe(1);
    // t1 still exists, no error thrown
    const count = core2.db.prepare('SELECT COUNT(*) as c FROM t1').get() as { c: number };
    expect(count.c).toBe(0);
    core2.close();
  });

  it('rolls back the transaction and does not advance schema_version when a migration throws', () => {
    const m1: Migration = {
      id: 1,
      name: 'create_t1',
      up: (db) => db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)'),
    };
    const m2: Migration = {
      id: 2,
      name: 'bad',
      up: () => {
        throw new Error('intentional failure');
      },
    };
    expect(() => new CoreDatabase({ filename: dbPath, migrations: [m1, m2] })).toThrow('intentional failure');

    // Re-open with only m1 (skip the bad m2): schema_version should still be 1
    // because the failed migration's transaction rolled back, and t1 must persist.
    const core2 = new CoreDatabase({ filename: dbPath, migrations: [m1] });
    expect(core2.schemaVersion).toBe(1);
    const t1 = core2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t1'")
      .all() as { name: string }[];
    expect(t1).toHaveLength(1);
    const t2 = core2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t2'")
      .all() as { name: string }[];
    expect(t2).toHaveLength(0);
    core2.close();
  });

  it('creates the parent directory if it does not exist', () => {
    const nestedPath = path.join(tempDir, 'nested', 'deep', 'core.db');
    const core = new CoreDatabase({ filename: nestedPath, migrations: [] });
    expect(fs.existsSync(nestedPath)).toBe(true);
    core.close();
  });
});

describe('startWalCheckpoint', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-wal-test-'));
    dbPath = path.join(tempDir, 'core.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns a stop function that is idempotent', () => {
    const stop = startWalCheckpoint(db);
    expect(typeof stop).toBe('function');
    // Calling stop multiple times should not throw
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it('runs a TRUNCATE checkpoint on stop', () => {
    const stop = startWalCheckpoint(db);
    // Write something to generate WAL content
    db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO foo (id) VALUES (?)').run(1);
    stop();
    // After TRUNCATE checkpoint, the WAL file should be empty or absent
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      const stat = fs.statSync(walPath);
      // TRUNCATE resets the WAL to zero size
      expect(stat.size).toBe(0);
    }
  });
});
