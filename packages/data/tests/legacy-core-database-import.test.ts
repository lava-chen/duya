import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importLegacyCoreDatabase } from '../src/legacy-core-database-import.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-core-merge-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createDatabase(filename: string, schema: string): Database.Database {
  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ${schema}`);
  return database;
}

describe('importLegacyCoreDatabase', () => {
  it('merges durable core rows by primary key, prefers core values, and skips runtime leases', () => {
    const directory = makeDirectory();
    const targetPath = path.join(directory, 'duya-main.db');
    const sourcePath = path.join(directory, 'duya-core.db');
    const schema = `
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE session_runtime_locks (session_id TEXT PRIMARY KEY, lock_id TEXT NOT NULL);
    `;
    const target = createDatabase(targetPath, schema);
    target.prepare('INSERT INTO sessions VALUES (?, ?)').run('shared', 'main-old');
    target.prepare('INSERT INTO session_runtime_locks VALUES (?, ?)').run('session', 'target-lock');
    target.close();

    const source = createDatabase(sourcePath, schema);
    source.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '12');
    source.prepare('INSERT INTO meta VALUES (?, ?)').run('imported_from_legacy', 'v46');
    source.prepare('INSERT INTO sessions VALUES (?, ?)').run('shared', 'core-current');
    source.prepare('INSERT INTO sessions VALUES (?, ?)').run('core-only', 'new row');
    source.prepare('INSERT INTO session_runtime_locks VALUES (?, ?)').run('session', 'stale-lock');
    source.close();

    const canonical = new Database(targetPath);
    try {
      expect(importLegacyCoreDatabase(canonical, sourcePath)).toMatchObject({
        importedTables: 1,
        importedRows: 2,
        skipped: false,
      });
      expect(canonical.prepare('SELECT id, title FROM sessions ORDER BY id').all()).toEqual([
        { id: 'core-only', title: 'new row' },
        { id: 'shared', title: 'core-current' },
      ]);
      expect(canonical.prepare('SELECT lock_id FROM session_runtime_locks').get()).toEqual({ lock_id: 'target-lock' });
      expect(canonical.prepare("SELECT value FROM meta WHERE key = 'imported_from_legacy'").get())
        .toEqual({ value: 'v46' });
      expect(importLegacyCoreDatabase(canonical, sourcePath)).toMatchObject({ skipped: true });
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.pre-unification`)).toBe(true);
    } finally {
      canonical.close();
    }
  });

  it('fails closed and rolls back when the target is missing a source table', () => {
    const directory = makeDirectory();
    const targetPath = path.join(directory, 'duya-main.db');
    const sourcePath = path.join(directory, 'duya-core.db');
    const target = createDatabase(targetPath, 'CREATE TABLE sessions (id TEXT PRIMARY KEY);');
    const source = createDatabase(sourcePath, 'CREATE TABLE unexpected (id TEXT PRIMARY KEY);');
    source.prepare('INSERT INTO unexpected VALUES (?)').run('row');
    source.close();

    try {
      expect(() => importLegacyCoreDatabase(target, sourcePath)).toThrow(
        'Legacy core table has no canonical schema: unexpected',
      );
      expect(target.prepare('SELECT value FROM meta WHERE key = ?').get('unified_database_imported_core')).toBeUndefined();
      expect(fs.existsSync(sourcePath)).toBe(true);
    } finally {
      target.close();
    }
  });

  it('fails closed when source columns are newer than the canonical schema', () => {
    const directory = makeDirectory();
    const targetPath = path.join(directory, 'duya-main.db');
    const sourcePath = path.join(directory, 'duya-core.db');
    const target = createDatabase(targetPath, 'CREATE TABLE sessions (id TEXT PRIMARY KEY);');
    const source = createDatabase(sourcePath, 'CREATE TABLE sessions (id TEXT PRIMARY KEY, future TEXT);');
    source.prepare('INSERT INTO sessions VALUES (?, ?)').run('row', 'newer-data');
    source.close();

    try {
      expect(() => importLegacyCoreDatabase(target, sourcePath)).toThrow(
        'Legacy core table sessions contains columns unknown to this Duya version: future',
      );
      expect(target.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    } finally {
      target.close();
    }
  });
});
