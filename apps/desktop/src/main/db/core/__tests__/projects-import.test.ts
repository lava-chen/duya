import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDatabase } from '../database';
import { ProjectStore, type ProjectBotRow, type ProjectRow } from '../project-store';
import { PROJECTS_IMPORTED_MARKER_KEY, needsProjectsImport, runProjectsImport } from '../projects-import';

describe('projects-import (plan 534 task 2.3)', () => {
  let tempDir: string;
  // Source DB pretending to be `memory-state.db` (has `projects` / `project_bots`).
  let source: Database.Database;
  let sourcePath: string;
  // Destination core DB (meta + projects via ProjectStore migrations).
  let core: CoreDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-import-test-'));
    sourcePath = path.join(tempDir, 'memory-state.db');
    source = new Database(sourcePath);
    // The memory-state schema only needs the projects tables for this test.
    source.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id      TEXT PRIMARY KEY,
        canonical_root  TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL DEFAULT '',
        description     TEXT,
        paths           TEXT NOT NULL DEFAULT '[]',
        icon            TEXT,
        color           TEXT,
        created_at      INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_bots (
        project_id  TEXT NOT NULL,
        bot_id      TEXT NOT NULL,
        joined_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, bot_id)
      );
    `);

    core = new CoreDatabase({
      filename: path.join(tempDir, 'duya-core.db'),
      migrations: ProjectStore.migrations,
    });
  });

  afterEach(() => {
    try {
      source.close();
    } catch {
      /* best-effort */
    }
    try {
      core.close();
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function seedProject(p: {
    project_id: string;
    canonical_root: string;
    name?: string;
    paths?: string;
    icon?: string | null;
    color?: string | null;
  }): void {
    const now = Date.now();
    source
      .prepare(
        `INSERT INTO projects (
          project_id, canonical_root, name, description, paths, icon, color,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.project_id,
        p.canonical_root,
        p.name ?? '',
        p.paths ?? '[]',
        p.icon ?? null,
        p.color ?? null,
        now,
        now,
      );
  }

  it('migrates all projects + bots and records the marker', () => {
    seedProject({
      project_id: 'p-1',
      canonical_root: 'E:/repos/one',
      name: 'duya',
      paths: '[{"path":"E:/repos/one","description":"main repo"}]',
      icon: 'rocket',
      color: 'blue',
    });
    seedProject({
      project_id: 'p-2',
      canonical_root: 'E:/repos/two',
      name: 'second',
    });
    source
      .prepare('INSERT INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)')
      .run('p-1', 'bot-a', 1000);

    expect(needsProjectsImport(core.db)).toBe(true);
    const report = runProjectsImport({ memoryDbPath: sourcePath, coreDb: core.db, sqlite: Database });

    expect(report).toMatchObject({ projects: 2, bots: 1, skipped: false });
    expect(needsProjectsImport(core.db)).toBe(false);

    const rows = core.db.prepare('SELECT * FROM projects ORDER BY project_id').all() as ProjectRow[];
    expect(rows).toHaveLength(2);
    const p1 = rows.find((r) => r.project_id === 'p-1')!;
    expect(p1.canonical_root).toBe('E:/repos/one');
    expect(p1.name).toBe('duya');
    expect(p1.icon).toBe('rocket');

    const bots = core.db.prepare('SELECT * FROM project_bots').all() as ProjectBotRow[];
    expect(bots).toEqual([{ project_id: 'p-1', bot_id: 'bot-a', joined_at: 1000 }]);
  });

  it('is idempotent: re-running after the marker is a no-op via needsProjectsImport', () => {
    seedProject({ project_id: 'p-1', canonical_root: 'E:/repos/one', name: 'duya' });
    runProjectsImport({ memoryDbPath: sourcePath, coreDb: core.db, sqlite: Database });

    // Marker written → caller skips. But even if forced, INSERT OR IGNORE must
    // not duplicate existing rows.
    const report = runProjectsImport({ memoryDbPath: sourcePath, coreDb: core.db, sqlite: Database });
    const count = (core.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    expect(count).toBe(1);
    expect(report.projects).toBe(1);
  });

  it('skips cleanly when the source memory-state.db does not exist', () => {
    const report = runProjectsImport({
      memoryDbPath: path.join(tempDir, 'no-such.db'),
      coreDb: core.db,
      sqlite: Database,
    });
    expect(report.skipped).toBe(true);
    expect(report.projects).toBe(0);
    // Source missing → nothing worth marking (a fresh user has no data).
    expect(needsProjectsImport(core.db)).toBe(true);
  });

  it('tolerates a source DB missing the projects tables (pre-0012)', () => {
    source.exec('DROP TABLE project_bots; DROP TABLE projects;');
    const report = runProjectsImport({ memoryDbPath: sourcePath, coreDb: core.db, sqlite: Database });
    expect(report.projects).toBe(0);
    expect(report.bots).toBe(0);
    expect(needsProjectsImport(core.db)).toBe(false);
  });

  it('does not overwrite a core project that already owns a canonical_root', () => {
    // A registration already wrote `E:/repos/one` into core with a NEW id.
    core.db
      .prepare(
        `INSERT INTO projects (
          project_id, canonical_root, name, description, paths, icon, color,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, NULL, '[]', NULL, NULL, ?, ?)`,
      )
      .run('core-new-id', 'E:/repos/one', 'existing', Date.now(), Date.now());
    // Source holds the same canonical_root under an old id.
    seedProject({ project_id: 'p-1', canonical_root: 'E:/repos/one', name: 'old' });

    runProjectsImport({ memoryDbPath: sourcePath, coreDb: core.db, sqlite: Database });

    const rows = core.db.prepare('SELECT * FROM projects').all() as ProjectRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('core-new-id'); // core's row wins, old not duplicated
    void PROJECTS_IMPORTED_MARKER_KEY;
  });
});