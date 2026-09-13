import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DbHandle } from 'better-sqlite3';
import { runMigrations } from '../migrations';
import {
  createProject,
  listProjects,
  projectPaths,
  ensurePlansDirs,
  writePlansIndex,
  readPlansIndex,
  type PlansIndexEntry,
} from '../projectService';
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
 * Plan 525 Phase 3 — project service + global plans directory layout.
 * Uses a real temp projects root (real fs) and a migrated memory DB.
 */
describe('project service (Plan 525 Phase 3)', () => {
  let temp: TempDbDir;
  let projectsRoot: string;
  let db: DbHandle;

  beforeEach(() => {
    temp = createTempDbDir();
    projectsRoot = path.join(temp.dir, 'projects');
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  const opts = () => ({ memoryDb: db, projectsRoot });

  it('1. createProject inserts a row with canonical_root derived from paths[0]', () => {
    const row = createProject(
      {
        name: 'duya',
        description: 'Agent desktop app',
        paths: [
          { path: 'e:/Projects/duya', description: 'main repo' },
          { path: 'e:/Projects/duya-website' },
        ],
      },
      opts()
    );

    expect(row.name).toBe('duya');
    expect(row.description).toBe('Agent desktop app');
    expect(row.canonical_root).toBe('e:/Projects/duya');
    expect(projectPaths(row)).toEqual([
      { path: 'e:/Projects/duya', description: 'main repo' },
      { path: 'e:/Projects/duya-website', description: null },
    ]);
    // UUID-shaped id (plan 525 §7: slug migration is a separate plan).
    expect(row.project_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. createProject creates the plans directory skeleton and an empty index.json', () => {
    const row = createProject(
      { name: 'duya', paths: [{ path: 'e:/Projects/duya' }] },
      opts()
    );

    const plansDir = path.join(projectsRoot, row.project_id, 'plans');
    expect(fs.statSync(path.join(plansDir, 'active')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(plansDir, 'completed')).isDirectory()).toBe(true);

    const index = JSON.parse(fs.readFileSync(path.join(plansDir, 'index.json'), 'utf8'));
    expect(index).toEqual({ projectId: row.project_id, plans: [] });
  });

  it('3. createProject rejects an empty paths list', () => {
    expect(() => createProject({ name: 'x', paths: [] }, opts())).toThrow(/at least one path/);
  });

  it('4. canonical_root UNIQUE violation surfaces as-is (user manages manually)', () => {
    createProject({ name: 'a', paths: [{ path: 'e:/same' }] }, opts());
    expect(() => createProject({ name: 'b', paths: [{ path: 'e:/same' }] }, opts())).toThrow(/UNIQUE/);
  });

  it('5. ensurePlansDirs is idempotent', () => {
    const row = createProject({ name: 'duya', paths: [{ path: 'e:/Projects/duya' }] }, opts());
    const again = ensurePlansDirs(row.project_id, opts());
    expect(fs.statSync(path.join(again.plansDir, 'active')).isDirectory()).toBe(true);
  });

  it('6. writePlansIndex / readPlansIndex round-trip entries', () => {
    const row = createProject({ name: 'duya', paths: [{ path: 'e:/Projects/duya' }] }, opts());
    const entries: PlansIndexEntry[] = [
      {
        id: 525,
        slug: 'project-entity-and-plan-management',
        title: 'Project 实体建模 + Plans 文件目录新设计',
        status: 'active',
        priority: 'P1',
        tags: ['project', 'plans'],
        file: 'active/525-project-entity-and-plan-management.md',
        created: '2026-09-12',
        updated: '2026-09-13',
      },
    ];
    const written = writePlansIndex(row.project_id, entries, opts());
    expect(written.projectId).toBe(row.project_id);
    expect(readPlansIndex(row.project_id, opts())).toEqual({
      projectId: row.project_id,
      plans: entries,
    });
  });

  it('7. readPlansIndex degrades to an empty index on missing or corrupted file', () => {
    expect(readPlansIndex('no-such-project', opts())).toEqual({ projectId: 'no-such-project', plans: [] });

    const row = createProject({ name: 'duya', paths: [{ path: 'e:/Projects/duya' }] }, opts());
    const indexPath = path.join(projectsRoot, row.project_id, 'plans', 'index.json');
    fs.writeFileSync(indexPath, '{corrupted', 'utf8');
    expect(readPlansIndex(row.project_id, opts())).toEqual({ projectId: row.project_id, plans: [] });
  });

  it('8. listProjects returns rows ordered by creation', () => {
    createProject({ name: 'a', paths: [{ path: 'e:/a' }] }, opts());
    createProject({ name: 'b', paths: [{ path: 'e:/b' }] }, opts());
    const rows = listProjects(opts());
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
  });
});
