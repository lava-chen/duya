import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrap, closeDb, getDb, isOpen } from '../db';
import { runMigrations } from '../migrations';
import { resolveMemoryDbPath } from '../path';
import { createTempDbDir, type TempDbDir } from './fixture';

// Shared mock logger — must be hoisted so vi.mock (also hoisted) sees it.
// Returning the same object on every getLogger() call keeps mock call
// records on one instance (matches apps/desktop/src/main/ipc/__tests__/logger-handlers.test.ts).
const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: {
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

describe('memory-state db', () => {
  let temp: TempDbDir;

  beforeEach(() => {
    temp = createTempDbDir();
  });

  afterEach(() => {
    closeDb();
    temp.cleanup();
  });

  it('1. bootstrap() twice in same process returns the same instance', () => {
    const a = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    const b = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    expect(b).toBe(a);
  });

  it('2. closeDb() then bootstrap() returns a new instance', () => {
    const a = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    closeDb();
    expect(isOpen()).toBe(false);
    const b = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    expect(b).not.toBe(a);
    expect(isOpen()).toBe(true);
  });

  it('3. WAL journal_mode is enabled', () => {
    const db = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('4. foreign_keys pragma is ON', () => {
    const db = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('5. busy_timeout is 5000ms', () => {
    const db = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
    const bt = db.pragma('busy_timeout', { simple: true });
    expect(bt).toBe(5000);
  });

  it('6. missing parent directory is created automatically', () => {
    const nestedDir = `${temp.dir}/nested/sub/dir`;
    // Directory does not exist yet.
    expect(fs.existsSync(nestedDir)).toBe(false);
    const db = bootstrap({
      bootJsonDatabaseDir: nestedDir,
      betterSqlite3Ctor: Database,
    });
    expect(db.open).toBe(true);
    // The DB file should exist inside the now-created directory.
    expect(fs.existsSync(`${nestedDir}/duya-main.db`)).toBe(true);
  });

  it('7. resolveMemoryDbPath throws when bootJsonDatabaseDir is missing', () => {
    expect(() => resolveMemoryDbPath()).toThrow(/boot\.json database directory is required/);
    expect(() => resolveMemoryDbPath({})).toThrow(/boot\.json database directory is required/);
    expect(() => resolveMemoryDbPath({ bootJsonDatabaseDir: '' })).toThrow(
      /boot\.json database directory is required/
    );
  });

  it('8. getDb() throws before bootstrap() is called', () => {
    closeDb();
    expect(() => getDb()).toThrow(/not bootstrapped/);
  });

  it('9. resolveMemoryDbPath joins dir + filename correctly', () => {
    const p = resolveMemoryDbPath({ bootJsonDatabaseDir: path.join('some', 'path') });
    expect(p).toBe(path.join(path.join('some', 'path'), 'duya-main.db'));
  });

  it('uses a supplied application connection without owning or closing it', () => {
    const shared = new Database(path.join(temp.dir, 'duya-main.db'));
    shared.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const memoryDb = bootstrap({ bootJsonDatabaseDir: temp.dir, database: shared });
    expect(memoryDb).toBe(shared);
    expect(shared.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toBeTruthy();
    closeDb();
    expect(shared.open).toBe(true);
    shared.close();
  });

  it('imports a legacy memory-state file into the shared database and retains a backup', () => {
    const legacy = new Database(path.join(temp.dir, 'memory-state.db'));
    runMigrations(legacy);
    legacy.prepare('INSERT INTO projects (project_id, canonical_root, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('project-1', '/work/project', 1, 2);
    legacy.prepare('INSERT INTO project_path_aliases (project_id, absolute_normalized_path, alias_kind, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', '/work/project/src', 'cwd', 3, 4);
    legacy.prepare(`INSERT INTO rollout_catalog
      (rollout_id, scope_kind, project_id, agent_type, last_seen_at, first_seen_at)
      VALUES (?, 'project', ?, 'main', ?, ?)`)
      .run('session-1', 'project-1', 5, 6);
    legacy.close();

    const shared = new Database(path.join(temp.dir, 'duya-main.db'));
    shared.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '', description TEXT, paths TEXT NOT NULL DEFAULT '[]',
        icon TEXT, color TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      );
    `);
    bootstrap({ bootJsonDatabaseDir: temp.dir, database: shared });

    expect(shared.prepare('SELECT canonical_root, name FROM projects WHERE project_id = ?').get('project-1'))
      .toEqual({ canonical_root: '/work/project', name: '' });
    expect(shared.prepare('SELECT absolute_normalized_path FROM project_path_aliases').get())
      .toEqual({ absolute_normalized_path: '/work/project/src' });
    expect(shared.prepare('SELECT rollout_id FROM rollout_catalog').get()).toEqual({ rollout_id: 'session-1' });
    expect(fs.existsSync(path.join(temp.dir, 'memory-state.db'))).toBe(false);
    expect(fs.existsSync(path.join(temp.dir, 'memory-state.db.pre-unification'))).toBe(true);
    closeDb();
    expect(shared.open).toBe(true);
    shared.close();
  });
});
