import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DbHandle } from 'better-sqlite3';
import { bootstrap, closeDb } from '../db';
import { createTempDbDir, type TempDbDir } from './fixture';
import {
  parseProjectPaths,
  serializeProjectPaths,
  type ProjectRow,
  type ProjectBotRow,
} from '../schema';

// Shared mock logger — must be hoisted so vi.mock (also hoisted) sees it
// (same pattern as db.test.ts).
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

describe('memory-state project entity (migration 0012)', () => {
  let temp: TempDbDir;
  let db: DbHandle;

  beforeEach(() => {
    temp = createTempDbDir();
    db = bootstrap({ bootJsonDatabaseDir: temp.dir, betterSqlite3Ctor: Database });
  });

  afterEach(() => {
    closeDb();
    temp.cleanup();
  });

  function insertProject(projectId: string, canonicalRoot: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (project_id, canonical_root, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`
    ).run(projectId, canonicalRoot, now, now);
  }

  it('1. migration 0012 adds name/description/paths columns with defaults', () => {
    insertProject('p-1', 'E:/repos/one');
    const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get('p-1') as ProjectRow;
    expect(row.name).toBe('');
    expect(row.description).toBeNull();
    expect(row.paths).toBe('[]');
  });

  it('2. writes and reads back name / description / paths', () => {
    insertProject('p-1', 'E:/repos/one');
    const paths = serializeProjectPaths([
      { path: 'E:/repos/one', description: 'main repo' },
      { path: 'E:/repos/one-site', description: null },
    ]);
    db.prepare('UPDATE projects SET name = ?, description = ?, paths = ? WHERE project_id = ?').run(
      'duya',
      'Agent desktop app',
      paths,
      'p-1'
    );

    const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get('p-1') as ProjectRow;
    expect(row.name).toBe('duya');
    expect(row.description).toBe('Agent desktop app');
    expect(parseProjectPaths(row.paths)).toEqual([
      { path: 'E:/repos/one', description: 'main repo' },
      { path: 'E:/repos/one-site', description: null },
    ]);
  });

  it('3. project_bots insert / list / delete with PK dedupe', () => {
    insertProject('p-1', 'E:/repos/one');
    const insert = db.prepare(
      'INSERT INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)'
    );
    insert.run('p-1', 'bot-a', 1000);
    insert.run('p-1', 'bot-b', 2000);

    // Duplicate membership rejected by the composite PK.
    expect(() => insert.run('p-1', 'bot-a', 3000)).toThrow();

    let rows = db
      .prepare('SELECT * FROM project_bots WHERE project_id = ? ORDER BY bot_id')
      .all('p-1') as ProjectBotRow[];
    expect(rows).toEqual([
      { project_id: 'p-1', bot_id: 'bot-a', joined_at: 1000 },
      { project_id: 'p-1', bot_id: 'bot-b', joined_at: 2000 },
    ]);

    // Bot-dimension lookup hits idx_project_bots_bot.
    rows = db.prepare('SELECT * FROM project_bots WHERE bot_id = ?').all('bot-a') as ProjectBotRow[];
    expect(rows).toEqual([{ project_id: 'p-1', bot_id: 'bot-a', joined_at: 1000 }]);

    db.prepare('DELETE FROM project_bots WHERE project_id = ? AND bot_id = ?').run('p-1', 'bot-a');
    rows = db.prepare('SELECT * FROM project_bots WHERE project_id = ?').all('p-1') as ProjectBotRow[];
    expect(rows).toEqual([{ project_id: 'p-1', bot_id: 'bot-b', joined_at: 2000 }]);
  });

  it('4. project_bots survives across projects independently', () => {
    insertProject('p-1', 'E:/repos/one');
    insertProject('p-2', 'E:/repos/two');
    const insert = db.prepare(
      'INSERT INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)'
    );
    insert.run('p-1', 'bot-a', 1000);
    insert.run('p-2', 'bot-a', 2000);

    const p1 = db.prepare('SELECT COUNT(*) AS n FROM project_bots WHERE project_id = ?').get('p-1') as { n: number };
    const p2 = db.prepare('SELECT COUNT(*) AS n FROM project_bots WHERE project_id = ?').get('p-2') as { n: number };
    expect(p1.n).toBe(1);
    expect(p2.n).toBe(1);
  });
});

describe('parseProjectPaths', () => {
  it('5. degrades corrupted JSON to empty array instead of throwing', () => {
    expect(parseProjectPaths('not-json{')).toEqual([]);
    expect(parseProjectPaths('{"path": "x"}')).toEqual([]); // valid JSON, not an array
  });

  it('6. handles null / empty / whitespace-only raw values', () => {
    expect(parseProjectPaths(null)).toEqual([]);
    expect(parseProjectPaths(undefined)).toEqual([]);
    expect(parseProjectPaths('')).toEqual([]);
  });

  it('7. drops entries without a path and normalizes descriptions to NULL', () => {
    const raw = JSON.stringify([
      { path: 'E:/a', description: 'kept' },
      { description: 'no path' },
      { path: '', description: 'empty path' },
      { path: 'E:/b' },
      { path: 'E:/c', description: '' },
      'not-an-object',
      null,
    ]);
    expect(parseProjectPaths(raw)).toEqual([
      { path: 'E:/a', description: 'kept' },
      { path: 'E:/b', description: null },
      { path: 'E:/c', description: null },
    ]);
  });

  it('8. serialize → parse round-trips entries', () => {
    const entries = [
      { path: 'E:/Projects/duya', description: 'main repo' },
      { path: 'E:/Papers/duya-research', description: null },
    ];
    expect(parseProjectPaths(serializeProjectPaths(entries))).toEqual(entries);
  });
});
