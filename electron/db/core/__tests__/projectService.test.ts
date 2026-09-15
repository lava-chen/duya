/**
 * projectService.test.ts — Plans-directory side-effects of
 * `createProject` / `updateProject` / `reconcileProjectPlansDirs` /
 * `ensureProjectPlansSkeleton`.
 *
 * Plan 525 Phase 3 puts the projects table on the core store and ties
 * its lifecycle to a `~/.duya/projects/<id>/plans/` skeleton. Projects
 * migrated in from the legacy `project_path_aliases` era (Phase 2.4)
 * never went through `createProject`, so they exist as rows but have
 * no plans directory. The renderer exposes them anyway and used to
 * leave them without a directory after 编辑项目 — this suite pins the
 * four guarantees:
 *
 *   1. `createProject` still creates the full plans skeleton
 *      (regression).
 *   2. `updateProject` creates the full plans skeleton for legacy
 *      projects that lack one — but never overwrites a pre-existing
 *      `plans/index.json`.
 *   3. `reconcileProjectPlansDirs` repairs every project whose plans
 *      dir is missing and is a no-op when all dirs already exist.
 *   4. `ensureProjectPlansSkeleton` is idempotent and safe to call
 *      twice on the same project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDatabase } from '../database';
import { ProjectStore, parseProjectPaths, serializeProjectPaths } from '../project-store';
import {
  createProject,
  CURRENT_PROJECT_AGENTS_MD_VERSION,
  ensurePlansDirs,
  ensureProjectAgentsMd,
  ensureProjectPlansSkeleton,
  projectAgentsMdMarker,
  readPlansIndex,
  readProjectAgentsMdVersion,
  reconcileProjectAgentsMd,
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

  it('updateProject repairs the full plans skeleton for a legacy project', () => {
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

    // Full skeleton must now exist: plans/, plans/active/, plans/completed/, plans/index.json.
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'active'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'completed'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'legacy-1', 'plans', 'index.json'))).toBe(true);

    // The seeded index.json must be a well-formed empty index for this project.
    const index = readPlansIndex('legacy-1', opts());
    expect(index.projectId).toBe('legacy-1');
    expect(index.plans).toEqual([]);
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

  it('reconcileProjectPlansDirs repairs every project lacking a plans dir + seeds empty index.json', () => {
    // 3 legacy projects, no plans dirs on disk.
    seedLegacyProject('legacy-a', 'E:/A');
    seedLegacyProject('legacy-b', 'E:/B');
    seedLegacyProject('legacy-c', 'E:/C');

    const report = reconcileProjectPlansDirs(opts());
    expect(report.scanned).toBe(3);
    expect(report.repaired).toBe(3);
    expect(report.indexSeeded).toBe(3);
    expect(report.errors).toEqual([]);

    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      // Full skeleton must exist after reconciliation.
      expect(fs.existsSync(path.join(projectsRoot, id, 'plans', 'active'))).toBe(true);
      expect(fs.existsSync(path.join(projectsRoot, id, 'plans', 'completed'))).toBe(true);
      expect(fs.existsSync(path.join(projectsRoot, id, 'plans', 'index.json'))).toBe(true);

      // Seeded index.json must be a well-formed empty index for the project.
      const index = readPlansIndex(id, opts());
      expect(index.projectId).toBe(id);
      expect(index.plans).toEqual([]);
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

  it('ensureProjectPlansSkeleton creates the full skeleton on first call and is idempotent after', () => {
    const first = ensureProjectPlansSkeleton('skel-id', opts());
    expect(first.plansDir).toBe(path.join(projectsRoot, 'skel-id', 'plans'));
    expect(first.indexWritten).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'skel-id', 'plans', 'active'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'skel-id', 'plans', 'completed'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'skel-id', 'plans', 'index.json'))).toBe(true);

    // Capture the index.json content before the second call so we can
    // detect any silent overwrite.
    const indexBefore = fs.readFileSync(
      path.join(projectsRoot, 'skel-id', 'plans', 'index.json'),
      'utf8',
    );

    const second = ensureProjectPlansSkeleton('skel-id', opts());
    expect(second.indexWritten).toBe(false);
    const indexAfter = fs.readFileSync(
      path.join(projectsRoot, 'skel-id', 'plans', 'index.json'),
      'utf8',
    );
    expect(indexAfter).toBe(indexBefore);
  });

  it('ensureProjectPlansSkeleton does NOT overwrite a real plans/index.json', () => {
    // Seed a project via createProject (which now also goes through
    // ensureProjectPlansSkeleton), then write a real plan entry.
    const row = createProject({ name: 'real', paths: [{ path: 'E:/real' }] }, opts());
    writePlansIndex(
      row.project_id,
      [
        {
          id: 7,
          slug: 'real-plan',
          title: 'Real plan',
          status: 'active',
          file: 'active/7-real-plan.md',
          created: '2026-09-14',
          updated: '2026-09-14',
        },
      ],
      opts(),
    );

    // Re-running the skeleton must not touch the existing index.
    const result = ensureProjectPlansSkeleton(row.project_id, opts());
    expect(result.indexWritten).toBe(false);
    const index = readPlansIndex(row.project_id, opts());
    expect(index.plans).toHaveLength(1);
    expect(index.plans[0].slug).toBe('real-plan');
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

/**
 * projectService — AGENTS.md version-token reconciliation.
 *
 * The seed file `~/.duya/projects/<id>/AGENTS.md` carries a hidden
 * version marker `<!-- duya-agents-md:version N -->`. The reconcile
 * pass upgrades any file whose recorded version is below
 * `CURRENT_PROJECT_AGENTS_MD_VERSION`. Files the user edited past the
 * current version must be left alone.
 */
describe('projectService — AGENTS.md version reconcile', () => {
  let tempDir: string;
  let core: CoreDatabase;
  let projectsRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectservice-agentsmd-'));
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

  function serviceOpts() {
    return {
      projectsDb: core.db,
      projectsRoot,
    };
  }

  function seedProjectRow(id: string, name: string, canonicalRoot: string): void {
    const now = Date.now();
    core.db
      .prepare(
        `INSERT INTO projects (
          project_id, canonical_root, name, description, paths, icon, color,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, canonicalRoot, name, '[]', now, now);
  }

  function writeAgentsMd(projectId: string, body: string): string {
    const dir = path.join(projectsRoot, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(filePath, body, 'utf8');
    return filePath;
  }

  function readAgentsMd(projectId: string): string {
    return fs.readFileSync(path.join(projectsRoot, projectId, 'AGENTS.md'), 'utf8');
  }

  function v1Body(): string {
    // Pre-marker legacy seed: no version line.
    return `# Project: legacy
> Seeded by duya.
## 1. What this project is
- **Home directory**: ...
`;
  }

  function v2Body(): string {
    return `${projectAgentsMdMarker(2)}
# Project: v2
> Seeded by duya.
## 3. The plan toolchain
- \`plan status\`
`;
  }

  function v3Body(): string {
    return `${projectAgentsMdMarker(3)}
# Project: v3
> Seeded by duya.
## 3. The plan toolchain
Every call must include projectId.
`;
  }

  function currentBodyWithMarker(): string {
    return `${projectAgentsMdMarker(CURRENT_PROJECT_AGENTS_MD_VERSION)}
# Project: current
`;
  }

  it('readProjectAgentsMdVersion returns 0 for unmarked legacy and the recorded number for marked files', () => {
    expect(readProjectAgentsMdVersion(v1Body())).toBe(0);
    expect(readProjectAgentsMdVersion(v2Body())).toBe(2);
    expect(readProjectAgentsMdVersion(v3Body())).toBe(3);
    // Tolerates whitespace and odd capitalization without throwing.
    expect(readProjectAgentsMdVersion('<!-- duya-agents-md:version   5  -->')).toBe(5);
    // Malformed → 0, not NaN.
    expect(readProjectAgentsMdVersion('<!-- duya-agents-md:version nonsense -->')).toBe(0);
  });

  it('createProject stamps AGENTS.md with the current version marker', () => {
    const row = createProject(
      { name: 'fresh', paths: [{ path: 'E:/fresh' }] },
      serviceOpts(),
    );
    const body = readAgentsMd(row.project_id);
    const version = readProjectAgentsMdVersion(body);
    expect(version).toBe(CURRENT_PROJECT_AGENTS_MD_VERSION);
    // The marker must be the very first line so a future grep for the
    // canonical version is reliable.
    expect(body.startsWith(projectAgentsMdMarker(CURRENT_PROJECT_AGENTS_MD_VERSION))).toBe(true);
  });

  it('ensureProjectAgentsMd creates when absent and stamps the current version', () => {
    const result = ensureProjectAgentsMd(
      'p-create',
      { projectName: 'p', canonicalRoot: 'E:/p' },
      serviceOpts(),
    );
    expect(result.created).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(result.version).toBe(CURRENT_PROJECT_AGENTS_MD_VERSION);
    expect(readProjectAgentsMdVersion(readAgentsMd('p-create'))).toBe(
      CURRENT_PROJECT_AGENTS_MD_VERSION,
    );
  });

  it('ensureProjectAgentsMd is a no-op when the file is already at the current version', () => {
    writeAgentsMd('p-current', currentBodyWithMarker());
    const before = readAgentsMd('p-current');

    const result = ensureProjectAgentsMd(
      'p-current',
      { projectName: 'p', canonicalRoot: 'E:/p' },
      serviceOpts(),
    );
    expect(result.created).toBe(false);
    expect(result.upgraded).toBe(false);
    expect(result.version).toBe(CURRENT_PROJECT_AGENTS_MD_VERSION);
    expect(readAgentsMd('p-current')).toBe(before);
  });

  it('ensureProjectAgentsMd upgrades a legacy (unmarked) file and stamps the current marker', () => {
    writeAgentsMd('p-legacy', v1Body());

    const result = ensureProjectAgentsMd(
      'p-legacy',
      { projectName: 'p', canonicalRoot: 'E:/p' },
      serviceOpts(),
    );
    expect(result.created).toBe(false);
    expect(result.upgraded).toBe(true);
    expect(result.version).toBe(CURRENT_PROJECT_AGENTS_MD_VERSION);

    const body = readAgentsMd('p-legacy');
    expect(readProjectAgentsMdVersion(body)).toBe(CURRENT_PROJECT_AGENTS_MD_VERSION);
    // The new template must mention the project_id reminder so the
    // agent learns where to write plans. Match the literal
    // `projectId: "<id>"` phrasing — wrapped in ** for emphasis, the
    // assertion slices between the asterisks to stay marker-agnostic.
    expect(body).toContain('Project ID');
    expect(body).toMatch(/projectId:\s*"p-legacy"/);
  });

  it('ensureProjectAgentsMd upgrades an older-version file (v2 → current)', () => {
    writeAgentsMd('p-v2', v2Body());

    const result = ensureProjectAgentsMd(
      'p-v2',
      { projectName: 'p', canonicalRoot: 'E:/p' },
      serviceOpts(),
    );
    expect(result.upgraded).toBe(true);
    expect(readProjectAgentsMdVersion(readAgentsMd('p-v2'))).toBe(
      CURRENT_PROJECT_AGENTS_MD_VERSION,
    );
  });

  it('ensureProjectAgentsMd does NOT touch a file the user edited past the current version', () => {
    // Pin a synthetic higher version so we can prove user-edited files
    // are never overwritten, even when their recorded version is above
    // CURRENT_PROJECT_AGENTS_MD_VERSION.
    const futureBody = `${projectAgentsMdMarker(99)}
# Project: hand-edited

> This body was hand-written by the user and must survive every upgrade.
`;
    writeAgentsMd('p-future', futureBody);

    const result = ensureProjectAgentsMd(
      'p-future',
      { projectName: 'p', canonicalRoot: 'E:/p' },
      serviceOpts(),
    );
    expect(result.created).toBe(false);
    expect(result.upgraded).toBe(false);
    expect(result.version).toBe(99);
    expect(readAgentsMd('p-future')).toBe(futureBody);
  });

  it('reconcileProjectAgentsMd upgrades legacy + v2 files and leaves current files alone', () => {
    seedProjectRow('p-legacy', 'Legacy', 'E:/legacy');
    seedProjectRow('p-v2', 'V2', 'E:/v2');
    seedProjectRow('p-current', 'Current', 'E:/current');

    writeAgentsMd('p-legacy', v1Body());
    writeAgentsMd('p-v2', v2Body());
    writeAgentsMd('p-current', currentBodyWithMarker());

    const report = reconcileProjectAgentsMd(serviceOpts());
    expect(report.scanned).toBe(3);
    expect(report.upgraded).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.errors).toEqual([]);

    // Legacy + v2 must both end up at the current version.
    expect(readProjectAgentsMdVersion(readAgentsMd('p-legacy'))).toBe(
      CURRENT_PROJECT_AGENTS_MD_VERSION,
    );
    expect(readProjectAgentsMdVersion(readAgentsMd('p-v2'))).toBe(
      CURRENT_PROJECT_AGENTS_MD_VERSION,
    );
    // Current file must be byte-identical (no spurious rewrite).
    expect(readAgentsMd('p-current')).toBe(currentBodyWithMarker());
  });

  it('reconcileProjectAgentsMd is a no-op when nothing needs upgrading', () => {
    const a = createProject({ name: 'a', paths: [{ path: 'E:/A' }] }, serviceOpts());
    const b = createProject({ name: 'b', paths: [{ path: 'E:/B' }] }, serviceOpts());
    expect([a.project_id, b.project_id]).toHaveLength(2);

    // Both projects have AGENTS.md stamped at CURRENT by createProject,
    // so the reconcile pass must record every file as `skipped`
    // (recorded version already >= current) — never `upgraded`, and
    // never an error.
    const report = reconcileProjectAgentsMd(serviceOpts());
    expect(report.scanned).toBe(2);
    expect(report.upgraded).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.errors).toEqual([]);
  });

  it('reconcileProjectAgentsMd preserves user-edited files past the current version', () => {
    seedProjectRow('p-future', 'Future', 'E:/future');
    const futureBody = `${projectAgentsMdMarker(99)}
# Project: hand-edited
user wrote this
`;
    writeAgentsMd('p-future', futureBody);

    const report = reconcileProjectAgentsMd(serviceOpts());
    expect(report.scanned).toBe(1);
    expect(report.upgraded).toBe(0);
    expect(report.skipped).toBe(1);
    expect(readAgentsMd('p-future')).toBe(futureBody);
  });

  it('reconcileProjectAgentsMd tolerates projects with no AGENTS.md on disk', () => {
    // A row exists but no file was ever seeded — skipped, not crashed.
    seedProjectRow('p-empty', 'Empty', 'E:/empty');
    const report = reconcileProjectAgentsMd(serviceOpts());
    expect(report.scanned).toBe(1);
    expect(report.upgraded).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.errors).toEqual([]);
  });

  it('updateProject upgrades an older AGENTS.md alongside the plans skeleton', () => {
    seedProjectRow('legacy-update', 'Legacy Update', 'E:/legacy-update');
    writeAgentsMd('legacy-update', v1Body());

    const updated = updateProject(
      'legacy-update',
      { name: 'Legacy Update Renamed' },
      serviceOpts(),
    );
    expect(updated).not.toBeNull();
    // The plans skeleton is also repaired by updateProject.
    expect(
      fs.existsSync(path.join(projectsRoot, 'legacy-update', 'plans', 'active')),
    ).toBe(true);
    // The AGENTS.md must be upgraded to the current version.
    expect(readProjectAgentsMdVersion(readAgentsMd('legacy-update'))).toBe(
      CURRENT_PROJECT_AGENTS_MD_VERSION,
    );
  });
});
