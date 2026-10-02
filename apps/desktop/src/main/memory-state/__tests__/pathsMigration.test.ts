import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DbHandle } from 'better-sqlite3';
import { runMigrations } from '../migrations';
import {
  buildPathsByProject,
  dryRunPathsMigration,
  applyPathsMigration,
  type LegacyAliasRow,
} from '../pathsMigration';
import { parseProjectPaths } from '../schema';
import { resolveProject } from '../projectResolver';
import { createTempDbDir, type TempDbDir } from './fixture';

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

/**
 * Plan 525 Phase 2 — project_path_aliases → projects.paths migration.
 * Tests run against a real file-backed DB with all migrations applied
 * (better-sqlite3 satisfies MinimalDb structurally).
 */
describe('paths migration (Plan 525 Phase 2)', () => {
  let temp: TempDbDir;
  let db: DbHandle;

  beforeEach(() => {
    temp = createTempDbDir();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // The project entity columns used to live in memory-state migration 0012.
    // Plan 534 moved them to duya-core.db, so recreate them on the test DB only
    // (projectResolver / resolveProject still read & write them here).
    db.exec(`
      ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN description TEXT;
      ALTER TABLE projects ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
    `);
  });

  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  function insertProject(projectId: string, canonicalRoot: string, paths = '[]'): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (project_id, canonical_root, created_at, last_seen_at, paths)
       VALUES (?, ?, ?, ?, ?)`
    ).run(projectId, canonicalRoot, now, now, paths);
  }

  function insertAlias(row: Partial<LegacyAliasRow> & { project_id: string; path: string }): void {
    db.prepare(
      `INSERT INTO project_path_aliases
         (project_id, absolute_normalized_path, relative_path, alias_kind, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.project_id,
      row.path,
      row.relative_path ?? null,
      row.alias_kind ?? 'working_directory',
      1000,
      2000
    );
  }

  describe('buildPathsByProject', () => {
    it('1. merges duplicate (project, path) rows across kinds, keeps first non-empty description', () => {
      const rows: LegacyAliasRow[] = [
        { project_id: 'p1', absolute_normalized_path: 'd:/duya', relative_path: null, alias_kind: 'cwd', first_seen_at: 1, last_seen_at: 2 },
        { project_id: 'p1', absolute_normalized_path: 'd:/duya', relative_path: null, alias_kind: 'working_directory', first_seen_at: 3, last_seen_at: 4, description: 'main repo' },
        { project_id: 'p1', absolute_normalized_path: 'd:/duya', relative_path: null, alias_kind: 'git_root', first_seen_at: 5, last_seen_at: 6 },
      ];
      const merged = buildPathsByProject(rows);
      expect(merged.get('p1')).toEqual([{ path: 'd:/duya', description: 'main repo' }]);
    });

    it('2. rows without descriptions land as NULL, groups stay independent', () => {
      const rows: LegacyAliasRow[] = [
        { project_id: 'p1', absolute_normalized_path: 'd:/a', relative_path: null, alias_kind: 'cwd', first_seen_at: 1, last_seen_at: 2 },
        { project_id: 'p1', absolute_normalized_path: 'd:/b', relative_path: 'sub', alias_kind: 'working_directory', first_seen_at: 1, last_seen_at: 2 },
        { project_id: 'p2', absolute_normalized_path: 'd:/a', relative_path: null, alias_kind: 'cwd', first_seen_at: 1, last_seen_at: 2 },
      ];
      const merged = buildPathsByProject(rows);
      expect(merged.get('p1')).toEqual([
        { path: 'd:/a', description: null },
        { path: 'd:/b', description: null },
      ]);
      expect(merged.get('p2')).toEqual([{ path: 'd:/a', description: null }]);
    });
  });

  describe('dryRunPathsMigration', () => {
    it('3. reports zeros on a fresh DB (table exists, no rows)', () => {
      const report = dryRunPathsMigration(db);
      expect(report.alias_table_exists).toBe(true);
      expect(report.total_alias_rows).toBe(0);
      expect(report.projects).toEqual([]);
    });

    it('4. reports per-project merge counts and pre-existing path entries', () => {
      insertProject('p1', 'd:/duya', JSON.stringify([{ path: 'd:/already-there', description: 'manual' }]));
      insertProject('p2', 'd:/other');
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      insertAlias({ project_id: 'p1', path: 'd:/duya-site' });
      insertAlias({ project_id: 'p2', path: 'd:/other' });

      // Note: the alias table's PK is the path itself, so a real table
      // never holds duplicate paths — same-path merging is only
      // reachable via buildPathsByProject unit tests (defensive).
      const report = dryRunPathsMigration(db);
      expect(report.total_alias_rows).toBe(3);
      expect(report.total_merged_paths).toBe(3);
      expect(report.orphan_project_ids).toEqual([]);
      expect(report.projects).toEqual([
        expect.objectContaining({
          project_id: 'p1',
          alias_row_count: 2,
          merged_path_count: 2,
          existing_path_count: 1,
        }),
        expect.objectContaining({
          project_id: 'p2',
          alias_row_count: 1,
          merged_path_count: 1,
          existing_path_count: 0,
        }),
      ]);
    });

    it('5. flags alias rows whose project row is missing as orphans', () => {
      insertProject('p1', 'd:/duya');
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      insertAlias({ project_id: 'ghost', path: 'd:/ghost-path' });

      const report = dryRunPathsMigration(db);
      expect(report.orphan_project_ids).toEqual(['ghost']);
      expect(report.orphan_alias_rows).toBe(1);
    });

    it('6. reports a missing alias table as already-migrated', () => {
      applyPathsMigration(db);
      const report = dryRunPathsMigration(db);
      expect(report.alias_table_exists).toBe(false);
      expect(report.total_alias_rows).toBe(0);
    });
  });

  describe('applyPathsMigration', () => {
    it('7. writes merged paths JSON and drops the alias table', () => {
      insertProject('p1', 'd:/duya');
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      insertAlias({ project_id: 'p1', path: 'd:/duya-site' });

      const result = applyPathsMigration(db);
      expect(result).toEqual({ updated_projects: 1, dropped_table: true });

      const row = db.prepare('SELECT paths FROM projects WHERE project_id = ?').get('p1') as {
        paths: string;
      };
      expect(parseProjectPaths(row.paths)).toEqual([
        { path: 'd:/duya', description: null },
        { path: 'd:/duya-site', description: null },
      ]);
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_path_aliases'")
        .get();
      expect(table).toBeUndefined();
    });

    it('8. unions with pre-existing paths entries; existing entries win on collision', () => {
      insertProject(
        'p1',
        'd:/duya',
        JSON.stringify([{ path: 'd:/duya', description: 'user label' }])
      );
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      insertAlias({ project_id: 'p1', path: 'd:/duya-extra' });

      applyPathsMigration(db);
      const row = db.prepare('SELECT paths FROM projects WHERE project_id = ?').get('p1') as {
        paths: string;
      };
      expect(parseProjectPaths(row.paths)).toEqual([
        { path: 'd:/duya', description: 'user label' },
        { path: 'd:/duya-extra', description: null },
      ]);
    });

    it('9. refuses to run with orphan alias rows and leaves data untouched', () => {
      insertProject('p1', 'd:/duya');
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      insertAlias({ project_id: 'ghost', path: 'd:/ghost-path' });

      expect(() => applyPathsMigration(db)).toThrow(/orphan|missing projects/i);

      const row = db.prepare('SELECT paths FROM projects WHERE project_id = ?').get('p1') as {
        paths: string;
      };
      expect(row.paths).toBe('[]');
      const n = db.prepare('SELECT COUNT(*) AS n FROM project_path_aliases').get() as { n: number };
      expect(n.n).toBe(2);
    });

    it('10. throws on a second run — the table is gone', () => {
      insertProject('p1', 'd:/duya');
      insertAlias({ project_id: 'p1', path: 'd:/duya' });
      applyPathsMigration(db);
      expect(() => applyPathsMigration(db)).toThrow(/already migrated|not found/);
    });
  });

  it('11. resolver works against migrated data — same path resolves to the same project', () => {
    insertProject('p1', 'd:/duya');
    insertAlias({ project_id: 'p1', path: 'd:/duya' });
    applyPathsMigration(db);

    const r = resolveProject({
      workingDirectory: 'D:/duya',
      memoryDb: db,
      platform: 'win32',
    });
    expect(r.project_id).toBe('p1');
    expect(r.resolution_source).toBe('working_directory');

    // And registering a NEW path still works post-migration.
    const r2 = resolveProject({
      workingDirectory: 'D:/duya-website',
      memoryDb: db,
      platform: 'win32',
    });
    expect(r2.project_id).not.toBe('p1');
  });
});
