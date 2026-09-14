/**
 * projectService.test.ts — Plans-directory side-effects of
 * `createProject` / `updateProject` / `reconcileProjectPlansDirs`.
 *
 * Plan 525 Phase 3 puts the projects table on the core store and ties
 * its lifecycle to a `~/.duya/projects/<id>/plans/` skeleton. Projects
 * migrated in from the legacy `project_path_aliases` era (Phase 2.4)
 * never went through `createProject`, so they exist as rows but have
 * no plans directory. The renderer exposes them anyway and used to
 * leave them without a directory after 编辑项目 — this suite pins the
 * three guarantees:
 *
 *   1. `createProject` still creates the plans skeleton (regression).
 *   2. `updateProject` creates the plans skeleton when the project
 *      does not yet have one — but never overwrites an existing
 *      `plans/index.json`.
 *   3. `reconcileProjectPlansDirs` repairs every project whose plans
 *      dir is missing and is a no-op when all dirs already exist.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDatabase } from '../database';
import { ProjectStore, parseProjectPaths, serializeProjectPaths } from '../project-store';
import {
  createProject,
  ensurePlansDirs,
  readPlansIndex,
  reconcileProjectPlansDirs,
  updateProject,
  writePlansIndex,
} from '../projectService';

describe('projectService — plans dir lifecycle', () => {
  let tempDir: string;
  let core: CoreDatabase;
  let projectsRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectservice-plans-'));
    core = new CoreDatabase({
      filename: path.join(tempDir, 'duya-core.db'),
      migrations: ProjectStore.migrations,
    });
    projectsRoot = path.join(tempDir, 'projects');
  });

  afterEach(() => {
    try { core.close(); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function opts() {
    return {
      projectsDb: core.db,
      projectsRoot,
    };
  }

  function seedLegacyProject(id: string, canonicalRoot: string): void {
    // Simulate a project that came in via the Phase 2.4 migration:
    // a row exists but no plans directory on disk.
    const now = Date.now();
    core.db
      .prepare(
        `INSERT INTO projects (
          project_id, canonical_root, name, description, paths, icon, color,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, canonicalRoot, '', '[]', now, now);
  }

  it('createProject seeds plans/active + plans/completed + index.json', () => {
    const row = createProject(
      {
        name: 'duya',
        paths: [{ path: 'E:/Projects/duya' }],
      },
      opts(),
    );
    const plansDir = path.join(projectsRoot, row.project_id, 'plans');
    expect(fs.existsSync(path.join(plansDir, 'active'))).toBe(true);
    expect(fs.existsSync(path.join(plansDir, 'completed'))).toBe(true);
    expect(fs.existsSync(path.join(plansDir, 'index.json'))).toBe(true);
    const index = readPlansIndex(row.project_id, opts());
    expect(index.projectId).toBe(row.project_id);
    expect(index.plans).toEqual([]);
  });

  it('updateProject repairs plans dir for a legacy project that lacks one', () => {
    // Seed a row that mimics Phase 2.4 migration output (no plans dir).
    seedLegacyProject('legacy-1', 'E:/Projects/legacy-1');
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1'))).toBe(false);

    const updated = updateProject(
      'legacy-1',
      { name: 'Legacy 1' },
      opts(),
    );
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Legacy 1');

    // plans/active + plans/completed must now exist.
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'active'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'completed'))).toBe(true);
    // We did NOT call writePlansIndex, so index.json must be absent.
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'index.json'))).toBe(false);
  });

  it('updateProject does NOT overwrite an existing plans/index.json', () => {
    // Seed a project whose plans already has a real entry.
    const row = createProject(
      { name: 'with-plans', paths: [{ path: 'E:/Projects/with-plans' }] },
      opts(),
    );
    writePlansIndex(
      row.project_id,
      [
        {
          id: 1,
          slug: 'first',
          title: 'First plan',
          status: 'active',
          file: 'active/1-first.md',
          created: '2026-09-14',
          updated: '2026-09-14',
        },
      ],
      opts(),
    );

    updateProject(row.project_id, { name: 'renamed' }, opts());

    // The pre-existing plan entry must still be there.
    const index = readPlansIndex(row.project_id, opts());
    expect(index.plans).toHaveLength(1);
    expect(index.plans[0].slug).toBe('first');
  });

  it('updateProject returns null for a missing projectId and does not throw', () => {
    const result = updateProject('does-not-exist', { name: 'x' }, opts());
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(projectsRoot, 'does-not-exist'))).toBe(false);
  });

  it('reconcileProjectPlansDirs repairs every project lacking a plans dir', () => {
    // 3 legacy projects, no plans dirs on disk.
    seedLegacyProject('legacy-a', 'E:/A');
    seedLegacyProject('legacy-b', 'E:/B');
    seedLegacyProject('legacy-c', 'E:/C');

    const report = reconcileProjectPlansDirs(opts());
    expect(report.scanned).toBe(3);
    expect(report.repaired).toBe(3);
    expect(report.errors).toEqual([]);

    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      expect(fs.existsSync(path.join(projectsRoot, id, 'plans', 'active'))).toBe(true);
      expect(fs.existsSync(path.join(projectsRoot, id, 'plans', 'completed'))).toBe(true);
    }
  });

  it('reconcileProjectPlansDirs is a no-op when every plans dir already exists', () => {
    const a = createProject({ name: 'a', paths: [{ path: 'E:/A' }] }, opts());
    const b = createProject({ name: 'b', paths: [{ path: 'E:/B' }] }, opts());
    expect([a.project_id, b.project_id]).toHaveLength(2);

    const report = reconcileProjectPlansDirs(opts());
    expect(report.scanned).toBe(2);
    expect(report.repaired).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('reconcileProjectPlansDirs only repairs the missing ones', () => {
    // One project via createProject (has plans dir) + one legacy project (missing).
    const a = createProject({ name: 'a', paths: [{ path: 'E:/A' }] }, opts());
    seedLegacyProject('legacy-x', 'E:/legacy-x');

    const report = reconcileProjectPlansDirs(opts());
    expect(report.scanned).toBe(2);
    expect(report.repaired).toBe(1);
    expect(fs.existsSync(path.join(projectsRoot, a.project_id, 'plans', 'active'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-x', 'plans', 'active'))).toBe(true);
  });

  it('ensurePlansDirs is idempotent (safe to call twice)', () => {
    ensurePlansDirs('idempotent-id', opts());
    ensurePlansDirs('idempotent-id', opts());
    expect(fs.existsSync(path.join(projectsRoot, 'idempotent-id', 'plans', 'active'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'idempotent-id', 'plans', 'completed'))).toBe(true);
  });

  it('parseProjectPaths / serializeProjectPaths round-trip the seeded legacy row', () => {
    // Smoke-check the helpers projectService re-exports — used by IPC
    // to keep `paths` as parsed JSON on the wire, not raw strings.
    // Note: serializeProjectPaths is a pure JSON layer; it does NOT
    // normalize drive-letter casing. Drive-letter lowercase happens
    // upstream in `normalizeProjectPathEntries` (called from
    // createProject / updateProject), so a round-trip via the pure
    // helpers preserves the input casing.
    seedLegacyProject('legacy-rt', 'E:/rt');
    const row = core.db.prepare('SELECT * FROM projects WHERE project_id = ?').get('legacy-rt') as {
      paths: string;
    };
    expect(parseProjectPaths(row.paths)).toEqual([]);
    expect(JSON.parse(serializeProjectPaths([{ path: 'E:/X', description: 'desc' }]))).toEqual([
      { path: 'E:/X', description: 'desc' },
    ]);
  });
});
