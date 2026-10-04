/**
 * workspace-identity.test.ts — plan 587 C6.2.
 *
 * The dry-run must report mappings, duplicates, missing paths and conflicts
 * before anything is written, and the apply must be additive and idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, serializeProjectPaths } from '../project-store';
import { WorkspaceStore } from '../workspace-store';
import {
  applyWorkspaceIdentity,
  deriveAlias,
  dryRunWorkspaceIdentity,
  ensureWorkspaceForProject,
} from '../workspace-identity';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  new Database(':memory:').close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('workspace identity migration', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let projects: ProjectStore;
  let workspaces: WorkspaceStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ws-identity-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of ProjectStore.migrations) m.up(db);
    for (const m of WorkspaceStore.migrations) m.up(db);
    projects = new ProjectStore(db);
    workspaces = new WorkspaceStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedMultiPathProject(): void {
    projects.insert({
      project_id: 'p-multi',
      canonical_root: 'E:/repos/duya',
      name: 'duya',
      paths: serializeProjectPaths([
        { path: 'E:/repos/duya', description: 'main repo' },
        { path: 'E:/repos/duya-site', description: 'site' },
      ]),
    });
  }

  it('dry-run writes nothing', () => {
    seedMultiPathProject();
    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.would_create_workspaces).toBe(1);
    const after = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('maps a multi-path project to ONE workspace holding the same root set', () => {
    seedMultiPathProject();
    const result = applyWorkspaceIdentity(db);
    expect(result.created_workspaces).toBe(1);
    expect(result.created_roots).toBe(2);

    const list = workspaces.listWorkspaces();
    expect(list).toHaveLength(1);
    const roots = workspaces.listRoots(list[0].workspace_id);
    expect(roots.map((r) => r.canonical_realpath).sort()).toEqual(['E:/repos/duya', 'E:/repos/duya-site']);
  });

  it('preserves the access the project already had, and says where it came from', () => {
    seedMultiPathProject();
    applyWorkspaceIdentity(db);
    const ws = workspaces.listWorkspaces()[0];
    const roots = workspaces.listRoots(ws.workspace_id);
    const primary = roots.find((r) => r.role === 'primary')!;
    const extra = roots.find((r) => r.role === 'source')!;

    // These paths were already injected as writable additionalDirectories.
    expect(primary.access).toBe('write');
    expect(primary.access_source).toBe('project_canonical_root');
    expect(extra.access).toBe('write');
    expect(extra.access_source).toBe('project_additional_path');
  });

  it('the migration never widens access: a new root defaults to read', () => {
    seedMultiPathProject();
    applyWorkspaceIdentity(db);
    const ws = workspaces.listWorkspaces()[0];
    const added = workspaces.insertRoot({
      workspace_id: ws.workspace_id,
      alias: 'fresh',
      canonical_realpath: 'E:/repos/fresh',
    });
    expect(added.access).toBe('read');
    expect(added.access_source).toBe('new_root_default');
  });

  it('carries the paths[] description onto the mapped root', () => {
    seedMultiPathProject();
    applyWorkspaceIdentity(db);
    const ws = workspaces.listWorkspaces()[0];
    const root = workspaces.listRoots(ws.workspace_id).find((r) => r.canonical_realpath === 'E:/repos/duya')!;
    expect(root.description).toBe('main repo');
  });

  it('reports a path claimed by two projects as a conflict, and maps it', () => {
    projects.insert({
      project_id: 'p-a',
      canonical_root: 'E:/shared',
      paths: serializeProjectPaths([{ path: 'E:/shared', description: null }]),
    });
    projects.insert({
      project_id: 'p-b',
      canonical_root: 'E:/other',
      paths: serializeProjectPaths([{ path: 'E:/other', description: null }, { path: 'E:/shared', description: null }]),
    });

    const plan = dryRunWorkspaceIdentity(db);
    const kinds = plan.conflicts.map((c) => c.kind);
    expect(kinds).toContain('path_claimed_by_other_project');
    expect(plan.duplicate_paths.map((d) => d.path)).toEqual(['E:/shared']);
    expect(plan.duplicate_paths[0].project_ids.sort()).toEqual(['p-a', 'p-b']);

    // Reported, not silently merged away.
    expect(plan.projects.find((p) => p.project_id === 'p-b')!.roots).toHaveLength(2);
  });

  it('reports a path repeated inside one project and collapses it', () => {
    projects.insert({
      project_id: 'p-dup',
      canonical_root: 'E:/x',
      paths: serializeProjectPaths([
        { path: 'E:/x', description: null },
        { path: 'E:/x', description: 'second' },
      ]),
    });
    const plan = dryRunWorkspaceIdentity(db);
    // paths[0] === canonical_root is the normal shape and is consumed
    // silently; the further repetition in paths[1] is a real duplicate and is
    // reported once, then collapsed to a single root.
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['duplicate_within_project']);
    expect(plan.projects[0].roots).toHaveLength(1);
  });

  it('reports a genuine repeat beyond the canonical root pairing', () => {
    projects.insert({
      project_id: 'p-dup2',
      canonical_root: 'E:/x',
      paths: serializeProjectPaths([
        { path: 'E:/x', description: null },
        { path: 'E:/y', description: 'first' },
        { path: 'E:/y', description: 'second' },
      ]),
    });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['duplicate_within_project']);
    expect(plan.conflicts[0].path).toBe('E:/y');
    expect(plan.projects[0].roots.map((r) => r.path)).toEqual(['E:/x', 'E:/y']);
  });

  it('does not flag the normal paths[0] === canonical_root shape as a conflict', () => {
    projects.insert({
      project_id: 'p-normal',
      canonical_root: 'E:/n',
      paths: serializeProjectPaths([{ path: 'E:/n', description: 'the only entry' }]),
    });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.conflicts).toEqual([]);
    expect(plan.projects[0].roots).toHaveLength(1);
    // The description still comes from paths[0], not the synthetic entry.
    expect(plan.projects[0].roots[0].description).toBe('the only entry');
  });

  it('reports a missing path but still maps it, so identity is not lost', () => {
    projects.insert({
      project_id: 'p-gone',
      canonical_root: 'E:/definitely/not/here',
      paths: serializeProjectPaths([{ path: 'E:/definitely/not/here', description: null }]),
    });
    const plan = dryRunWorkspaceIdentity(db, { probeFilesystem: true });
    expect(plan.missing_paths).toEqual([{ project_id: 'p-gone', path: 'E:/definitely/not/here' }]);
    expect(plan.projects[0].roots).toHaveLength(1);

    applyWorkspaceIdentity(db, { probeFilesystem: true });
    const ws = workspaces.getWorkspaceByProject('p-gone')!;
    expect(workspaces.listRoots(ws.workspace_id)).toHaveLength(1);
  });

  it('reports a real on-disk path as present', () => {
    const real = fs.realpathSync.native(tempDir);
    projects.insert({
      project_id: 'p-real',
      canonical_root: real,
      paths: serializeProjectPaths([{ path: real, description: null }]),
    });
    const plan = dryRunWorkspaceIdentity(db, { probeFilesystem: true });
    expect(plan.missing_paths).toEqual([]);
  });

  it('reports an alias collision and suffixes it', () => {
    projects.insert({
      project_id: 'p-alias',
      canonical_root: 'E:/one/app',
      paths: serializeProjectPaths([
        { path: 'E:/one/app', description: null },
        { path: 'E:/two/app', description: null },
      ]),
    });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.conflicts.map((c) => c.kind)).toContain('alias_collision');
    expect(plan.projects[0].roots.map((r) => r.alias).sort()).toEqual(['app', 'app-2']);
  });

  it('reports canonical_root that is absent from paths[] instead of guessing', () => {
    projects.insert({
      project_id: 'p-mismatch',
      canonical_root: 'E:/canonical',
      paths: serializeProjectPaths([{ path: 'E:/paths-only', description: null }]),
    });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.conflicts.map((c) => c.kind)).toContain('canonical_root_not_in_paths');
    // Both real grants are mapped.
    expect(plan.projects[0].roots).toHaveLength(2);
  });

  it('a project with an empty paths[] still gets its canonical_root', () => {
    projects.insert({ project_id: 'p-empty', canonical_root: 'E:/bare', paths: '[]' });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.projects[0].roots.map((r) => r.path)).toEqual(['E:/bare']);
  });

  it('survives a corrupted paths[] payload without throwing', () => {
    projects.insert({ project_id: 'p-bad', canonical_root: 'E:/bad', paths: '{not json' });
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.projects[0].roots.map((r) => r.path)).toEqual(['E:/bad']);
  });

  it('is idempotent — a second apply creates nothing and keeps one workspace', () => {
    seedMultiPathProject();
    const first = applyWorkspaceIdentity(db);
    expect(first.created_workspaces).toBe(1);
    const second = applyWorkspaceIdentity(db);
    expect(second.created_workspaces).toBe(0);
    expect(second.created_roots).toBe(0);
    expect(second.skipped_projects).toEqual(['p-multi']);
    expect(workspaces.listWorkspaces()).toHaveLength(1);
    expect(workspaces.listRoots(workspaces.listWorkspaces()[0].workspace_id)).toHaveLength(2);
  });

  it('leaves projects and projects.paths untouched', () => {
    seedMultiPathProject();
    const before = projects.get('p-multi')!;
    const result = applyWorkspaceIdentity(db);
    expect(result.projects_after).toBe(1);
    expect(result.projects_untouched).toBe(true);
    const after = projects.get('p-multi')!;
    expect(after.paths).toBe(before.paths);
    expect(after.canonical_root).toBe(before.canonical_root);
    expect(after.project_id).toBe(before.project_id);
  });

  it('never deletes a project private config / plans / AGENTS rows', () => {
    // The plans index lives in the per-project home dir, not in SQL, so the
    // durable assertion is that the project row and its id survive the
    // migration untouched and the home directory is not touched by it.
    const project = projects.insert({
      project_id: 'p-private',
      canonical_root: 'E:/private',
      paths: serializeProjectPaths([{ path: 'E:/private', description: null }]),
    });
    const home = path.join(tempDir, 'projects', project.project_id);
    fs.mkdirSync(path.join(home, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(home, 'plans', 'index.json'), '{"plans":[]}');
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# project agents');

    applyWorkspaceIdentity(db);

    expect(projects.get('p-private')).not.toBeNull();
    expect(fs.readFileSync(path.join(home, 'plans', 'index.json'), 'utf8')).toBe('{"plans":[]}');
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('# project agents');
  });

  it('ensureWorkspaceForProject mints one workspace and is idempotent', () => {
    seedMultiPathProject();
    const first = ensureWorkspaceForProject(db, 'p-multi');
    expect(first).not.toBeNull();
    const second = ensureWorkspaceForProject(db, 'p-multi');
    expect(second).toBeNull();
    expect(workspaces.listWorkspaces()).toHaveLength(1);
  });

  it('dry-runs on a database that has projects but not yet workspaces', () => {
    // This is the pre-migration state a dry run exists to describe: the
    // `projects` table is present, the workspace tables are not.
    seedMultiPathProject();
    db.exec('DROP TABLE workspace_session_bindings');
    db.exec('DROP TABLE workspace_roots');
    db.exec('DROP TABLE workspaces');

    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.total_projects).toBe(1);
    expect(plan.would_create_workspaces).toBe(1);
    expect(plan.would_create_roots).toBe(2);
    expect(plan.projects[0].roots.map((r) => r.access_source).sort()).toEqual([
      'project_additional_path',
      'project_canonical_root',
    ]);
  });

  it('returns an empty report when the projects table does not exist', () => {
    db.exec('DROP TABLE workspace_session_bindings');
    db.exec('DROP TABLE workspace_roots');
    db.exec('DROP TABLE workspaces');
    db.exec('DROP TABLE projects');
    const plan = dryRunWorkspaceIdentity(db);
    expect(plan.total_projects).toBe(0);
    expect(plan.would_create_workspaces).toBe(0);
  });

  it('deriveAlias produces a stable lowercase segment', () => {
    expect(deriveAlias('E:/repos/Duya-App')).toBe('duya-app');
    expect(deriveAlias('E:/repos/')).toBe('repos');
    expect(deriveAlias('/')).toBe('root');
  });
});
