/**
 * workspace-resolver.test.ts — plan 587 C6.2.
 *
 * Covers the compatibility resolver and the four required cases: a session
 * with no Project, a multi-path Project, a missing root, and a revoked root.
 * The load-bearing property is that a legacy session's first explicit
 * resolution produces a repeatable binding, so a rename or a relocate is a
 * revision rather than a re-key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, serializeProjectPaths } from '../project-store';
import { WorkspaceStore } from '../workspace-store';
import { applyWorkspaceIdentity } from '../workspace-identity';
import { normalizePath } from '../../../memory-state/pathUtils';
import {
  absolutePathFromRoot,
  relativePathWithin,
  resolveWorkspaceBinding,
} from '../workspace-resolver';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  new Database(':memory:').close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('workspace compatibility resolver', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let projects: ProjectStore;
  let workspaces: WorkspaceStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ws-resolver-'));
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
        { path: 'E:/repos/duya', description: 'main' },
        { path: 'E:/repos/duya-site', description: 'site' },
      ]),
    });
    applyWorkspaceIdentity(db);
  }

  it('relativePathWithin splits a cwd into root + relative path', () => {
    expect(relativePathWithin('E:/repos/duya', 'E:/repos/duya')).toBe('');
    expect(relativePathWithin('E:/repos/duya', 'E:/repos/duya/apps/desktop')).toBe('apps/desktop');
    expect(relativePathWithin('E:/repos/duya', 'E:/elsewhere')).toBe('');
  });

  it('absolutePathFromRoot rejoins a root and a relative path', () => {
    expect(absolutePathFromRoot('E:/repos/duya', '')).toBe('E:/repos/duya');
    expect(absolutePathFromRoot('E:/repos/duya', 'apps/desktop')).toBe('E:/repos/duya/apps/desktop');
  });

  // ─── case: a session with no Project ───

  it('leaves a session with no Project unbound and does not invent a workspace', () => {
    const result = resolveWorkspaceBinding({ db, sessionId: 's-orphan', cwd: 'E:/nowhere/at/all' });
    expect(result.status).toBe('no_workspace');
    expect(result.binding).toBeNull();
    expect(result.workspace).toBeNull();
    expect(workspaces.listWorkspaces()).toEqual([]);
    expect(workspaces.getBinding('s-orphan')).toBeNull();
  });

  it('ignores an empty cwd instead of binding to nothing', () => {
    const result = resolveWorkspaceBinding({ db, sessionId: 's-empty', cwd: '   ' });
    expect(result.status).toBe('no_workspace');
    expect(result.notes[0]).toMatch(/nothing to bind/);
  });

  // ─── case: a multi-path Project ───

  it('binds a legacy session on first resolution and marks it legacy', () => {
    seedMultiPathProject();
    const result = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya/apps/desktop' });
    expect(result.status).toBe('bound');
    expect(result.binding!.binding_kind).toBe('legacy');
    expect(result.binding!.project_id).toBe('p-multi');
    expect(result.binding!.relative_path).toBe('apps/desktop');
    expect(result.notes.join(' ')).toMatch(/below root/);
  });

  it('a second resolution of the same session returns the same binding and writes nothing', () => {
    seedMultiPathProject();
    const first = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya/apps/desktop' });
    const second = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya/apps/desktop' });
    expect(first.status).toBe('bound');
    expect(second.status).toBe('existing');
    expect(second.binding!.session_id).toBe(first.binding!.session_id);
    expect(second.binding!.workspace_id).toBe(first.binding!.workspace_id);
    expect(second.binding!.root_id).toBe(first.binding!.root_id);
    expect(second.binding!.created_at).toBe(first.binding!.created_at);
    expect(workspaces.listBindings(first.workspace!.workspace_id)).toHaveLength(1);
  });

  it('grants every root of a multi-path project with its provenance', () => {
    seedMultiPathProject();
    const result = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya' });
    const sources = result.granted_roots
      .map((r) => `${r.canonical_realpath}:${r.access}:${r.access_source}`)
      .sort();
    expect(sources).toEqual(
      [
        'E:/repos/duya:write:project_canonical_root',
        'E:/repos/duya-site:write:project_additional_path',
      ].sort(),
    );
  });

  it('binds a session whose cwd sits under a non-primary root', () => {
    seedMultiPathProject();
    const result = resolveWorkspaceBinding({ db, sessionId: 's-2', cwd: 'E:/repos/duya-site' });
    expect(result.status).toBe('bound');
    expect(result.root!.access_source).toBe('project_additional_path');
  });

  it('prefers the longest matching root when roots are nested', () => {
    projects.insert({
      project_id: 'p-nested',
      canonical_root: 'E:/nest',
      paths: serializeProjectPaths([
        { path: 'E:/nest', description: null },
        { path: 'E:/nest/inner', description: null },
      ]),
    });
    applyWorkspaceIdentity(db);
    const result = resolveWorkspaceBinding({ db, sessionId: 's-3', cwd: 'E:/nest/inner/deep' });
    expect(result.root!.canonical_realpath).toBe('E:/nest/inner');
    expect(result.binding!.relative_path).toBe('deep');
  });

  // ─── rename / relocate is a revision, not a re-key ───

  it('a relocate keeps the workspace, the root and the binding, and only bumps the revision', () => {
    seedMultiPathProject();
    const before = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya/apps/desktop' });
    const rootId = before.root!.root_id;
    const workspaceId = before.workspace!.workspace_id;
    const projectId = before.workspace!.project_id;

    const revision = workspaces.relocateRoot(rootId, 'E:/moved/duya');

    expect(revision).toBe(2);
    const after = resolveWorkspaceBinding({ db, sessionId: 's-1', cwd: 'E:/repos/duya/apps/desktop' });
    expect(after.status).toBe('existing');
    expect(after.workspace!.workspace_id).toBe(workspaceId);
    expect(after.workspace!.project_id).toBe(projectId);
    expect(after.root!.root_id).toBe(rootId);
    expect(after.binding!.relative_path).toBe('apps/desktop');
    // The old cwd now resolves to the NEW location of the same root.
    expect(after.resolved_cwd).toBe('E:/moved/duya/apps/desktop');
    expect(workspaces.listWorkspaces()).toHaveLength(1);
  });

  it('a session that had not resolved yet follows the new location on first resolution', () => {
    seedMultiPathProject();
    const root = workspaces.listRoots(workspaces.listWorkspaces()[0].workspace_id)[0];
    workspaces.relocateRoot(root.root_id, 'E:/moved/duya');

    const result = resolveWorkspaceBinding({ db, sessionId: 's-new', cwd: 'E:/moved/duya/apps/desktop' });
    expect(result.status).toBe('bound');
    expect(result.workspace!.revision).toBe(2);
    expect(result.binding!.revision_seen).toBe(2);
    expect(result.root!.root_id).toBe(root.root_id);
  });

  // ─── case: a missing root ───

  it('keeps the binding for a root that no longer exists on disk', () => {
    projects.insert({
      project_id: 'p-missing',
      canonical_root: 'E:/deleted/root',
      paths: serializeProjectPaths([{ path: 'E:/deleted/root', description: null }]),
    });
    applyWorkspaceIdentity(db);

    const result = resolveWorkspaceBinding({
      db,
      sessionId: 's-gone',
      cwd: 'E:/deleted/root',
      probeFilesystem: true,
    });

    expect(result.status).toBe('bound');
    expect(result.root_missing).toBe(true);
    expect(result.workspace!.project_id).toBe('p-missing');
    // The identity survives: the root row is still there.
    expect(workspaces.getRoot(result.root!.root_id)!.canonical_realpath).toBe('E:/deleted/root');
  });

  it('keeps the binding for a session whose cwd directory was deleted', () => {
    const repo = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    // Seed exactly what the storage side stores: a normalized path.
    const real = normalizePath(fs.realpathSync.native(repo)).absolute_normalized_path;
    projects.insert({
      project_id: 'p-real',
      canonical_root: real,
      paths: serializeProjectPaths([{ path: real, description: null }]),
    });
    applyWorkspaceIdentity(db);

    const first = resolveWorkspaceBinding({ db, sessionId: 's-del', cwd: `${real}/pkg` });
    expect(first.status).toBe('bound');

    fs.rmSync(path.join(repo, 'pkg'), { recursive: true, force: true });

    const second = resolveWorkspaceBinding({
      db,
      sessionId: 's-del',
      cwd: `${real}/pkg`,
      probeFilesystem: true,
    });
    expect(second.status).toBe('existing');
    expect(second.root_missing).toBe(true);
    expect(second.root!.root_id).toBe(first.root!.root_id);
  });

  // ─── case: a revoked root ───

  it('reports a revoked root and excludes it from the granted roots', () => {
    seedMultiPathProject();
    const ws = workspaces.listWorkspaces()[0];
    const site = workspaces.listRoots(ws.workspace_id).find((r) => r.canonical_realpath === 'E:/repos/duya-site')!;

    workspaces.setAccess(site.root_id, 'none', 'revoked');

    const result = resolveWorkspaceBinding({ db, sessionId: 's-rev', cwd: 'E:/repos/duya-site' });
    expect(result.status).toBe('bound');
    expect(result.root_revoked).toBe(true);
    expect(result.notes.join(' ')).toMatch(/revoked/);
    expect(result.granted_roots.map((r) => r.canonical_realpath)).toEqual(['E:/repos/duya']);
    // The root row is retained — revocation never re-keys.
    expect(workspaces.getRoot(site.root_id)!.canonical_realpath).toBe('E:/repos/duya-site');
  });

  it('a revoked root that is later re-granted returns to the granted set', () => {
    seedMultiPathProject();
    const ws = workspaces.listWorkspaces()[0];
    const site = workspaces.listRoots(ws.workspace_id).find((r) => r.canonical_realpath === 'E:/repos/duya-site')!;
    workspaces.setAccess(site.root_id, 'none', 'revoked');
    workspaces.setAccess(site.root_id, 'write', 'user_grant');

    const result = resolveWorkspaceBinding({ db, sessionId: 's-rev2', cwd: 'E:/repos/duya' });
    expect(result.root_revoked).toBe(false);
    expect(result.granted_roots.find((r) => r.root_id === site.root_id)!.access_source).toBe('user_grant');
  });

  // ─── the compatibility window for a not-yet-migrated Project ───

  it('mints a workspace on first resolution for a project that was never bulk-migrated', () => {
    projects.insert({
      project_id: 'p-lazy',
      canonical_root: 'E:/lazy',
      paths: serializeProjectPaths([{ path: 'E:/lazy', description: null }]),
    });
    expect(workspaces.listWorkspaces()).toEqual([]);

    const result = resolveWorkspaceBinding({ db, sessionId: 's-lazy', cwd: 'E:/lazy' });
    expect(result.status).toBe('bound');
    expect(result.notes.join(' ')).toMatch(/created one on first resolution/);
    expect(workspaces.listWorkspaces()).toHaveLength(1);
    expect(workspaces.getWorkspaceByProject('p-lazy')).not.toBeNull();
  });

  it('does not write a second workspace when two sessions resolve the same cwd', () => {
    projects.insert({
      project_id: 'p-two',
      canonical_root: 'E:/two',
      paths: serializeProjectPaths([{ path: 'E:/two', description: null }]),
    });
    const a = resolveWorkspaceBinding({ db, sessionId: 's-a', cwd: 'E:/two' });
    const b = resolveWorkspaceBinding({ db, sessionId: 's-b', cwd: 'E:/two' });
    expect(a.workspace!.workspace_id).toBe(b.workspace!.workspace_id);
    expect(workspaces.listWorkspaces()).toHaveLength(1);
    expect(workspaces.listBindings(a.workspace!.workspace_id)).toHaveLength(2);
  });
});
