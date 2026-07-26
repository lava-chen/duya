import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrap, closeDb, getDb, isOpen } from '../db';
import { resolveMemoryDbPath } from '../path';
import { createTempDbDir, type TempDbDir } from './fixture';

// Shared mock logger — must be hoisted so vi.mock (also hoisted) sees it.
// Returning the same object on every getLogger() call keeps mock call
// records on one instance (matches electron/ipc/__tests__/logger-handlers.test.ts).
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
    expect(fs.existsSync(`${nestedDir}/memory-state.db`)).toBe(true);
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
    expect(p).toBe(path.join(path.join('some', 'path'), 'memory-state.db'));
  });
});
