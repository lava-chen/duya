/**
 * workspace-store.test.ts — plan 587 C6.2.
 *
 * Covers the additive Workspace/root/session-binding schema on `duya-core.db`
 * and the identity guarantees that make a rename or relocate a revision
 * rather than a re-key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, parseProjectPaths } from '../project-store';
import { WorkspaceStore } from '../workspace-store';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  new Database(':memory:').close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('WorkspaceStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let projects: ProjectStore;
  let store: WorkspaceStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-workspace-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Realistic order: the `projects` table (id 18) before the workspace
    // tables (id 38), in the same database and the same migration sequence.
    for (const m of ProjectStore.migrations) m.up(db);
    for (const m of WorkspaceStore.migrations) m.up(db);
    projects = new ProjectStore(db);
    store = new WorkspaceStore(db);
    // The two Projects the per-test workspaces bind to. Each test gets a
    // fresh database, so re-seeding here cannot leak between tests.
    seedProject('p-1', 'E:/p-1');
    seedProject('p-2', 'E:/p-2');
  });

  /**
   * A Workspace may only bind an existing Project — `workspaces.project_id`
   * is a real foreign key, so the Project row has to exist first.
   */
  function seedProject(projectId: string, canonicalRoot: string): void {
    projects.insert({ project_id: projectId, canonical_root: canonicalRoot });
  }

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('is additive — it does not alter the projects table', () => {
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'projects'").get() as { sql: string };
    for (const m of WorkspaceStore.migrations) m.up(db);
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'projects'").get() as { sql: string };
    expect(after.sql).toBe(before.sql);
  });

  it('mints a device-local UUID workspace and round-trips it', () => {
    const ws = store.insertWorkspace({ name: 'duya', project_id: 'p-1' });
    expect(ws.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(ws.name).toBe('duya');
    expect(ws.project_id).toBe('p-1');
    expect(ws.revision).toBe(1);
    expect(store.getWorkspace(ws.workspace_id)).toEqual(ws);
  });

  it('a scratch workspace has no project', () => {
    const ws = store.insertWorkspace({ name: 'scratch' });
    expect(ws.project_id).toBeNull();
    expect(store.getWorkspaceByProject(ws.workspace_id)).toBeNull();
  });

  it('a newly added root defaults to read, not write', () => {
    const ws = store.insertWorkspace({ project_id: 'p-1' });
    const root = store.insertRoot({ workspace_id: ws.workspace_id, alias: 'new', canonical_realpath: 'E:/new' });
    expect(root.access).toBe('read');
    expect(root.access_source).toBe('new_root_default');
  });

  it('records where a grant came from alongside the access it produced', () => {
    const ws = store.insertWorkspace({ project_id: 'p-1' });
    const root = store.insertRoot({
      workspace_id: ws.workspace_id,
      alias: 'api',
      canonical_realpath: 'E:/api',
      access: 'write',
      access_source: 'project_additional_path',
    });
    expect({ access: root.access, source: root.access_source }).toEqual({
      access: 'write',
      source: 'project_additional_path',
    });
  });

  it('rejects a duplicate alias inside one workspace', () => {
    const ws = store.insertWorkspace({ project_id: 'p-1' });
    store.insertRoot({ workspace_id: ws.workspace_id, alias: 'app', canonical_realpath: 'E:/a/app' });
    expect(() =>
      store.insertRoot({ workspace_id: ws.workspace_id, alias: 'app', canonical_realpath: 'E:/b/app' }),
    ).toThrow();
  });

  it('relocateRoot keeps root_id and workspace_id and bumps the revision', () => {
    const ws = store.insertWorkspace({ project_id: 'p-1' });
    const root = store.insertRoot({ workspace_id: ws.workspace_id, alias: 'app', canonical_realpath: 'E:/app' });
    const revision = store.relocateRoot(root.root_id, 'E:/renamed/app');
    expect(revision).toBe(2);
    const after = store.getRoot(root.root_id)!;
    expect(after.root_id).toBe(root.root_id);
    expect(after.workspace_id).toBe(ws.workspace_id);
    expect(after.canonical_realpath).toBe('E:/renamed/app');
    expect(store.getWorkspace(ws.workspace_id)!.revision).toBe(2);
  });

  it('upsertBinding writes once and is repeatable for the same session', () => {
    const ws = store.insertWorkspace({ project_id: 'p-1' });
    const root = store.insertRoot({ workspace_id: ws.workspace_id, alias: 'app', canonical_realpath: 'E:/app' });
    const input = {
      session_id: 's-1',
      workspace_id: ws.workspace_id,
      root_id: root.root_id,
      relative_path: 'src',
      binding_kind: 'legacy' as const,
      project_id: 'p-1',
      resolved_from_cwd: 'E:\\app\\src',
      revision_seen: 1,
    };
    const first = store.upsertBinding(input);
    expect(first.created).toBe(true);
    const second = store.upsertBinding({ ...input, resolved_from_cwd: 'E:/somewhere/else' });
    expect(second.created).toBe(false);
    expect(second.row.resolved_from_cwd).toBe('E:\\app\\src');
    expect(store.listBindings(ws.workspace_id)).toHaveLength(1);
  });

  it('a session binding survives its project being deleted (no re-key)', () => {
    const projectStore = new ProjectStore(db);
    const project = projectStore.insert({ project_id: 'p-doomed', canonical_root: 'E:/app' });
    const ws = store.insertWorkspace({ project_id: project.project_id });
    const root = store.insertRoot({ workspace_id: ws.workspace_id, alias: 'app', canonical_realpath: 'E:/app' });
    store.upsertBinding({
      session_id: 's-1',
      workspace_id: ws.workspace_id,
      root_id: root.root_id,
      relative_path: '',
      binding_kind: 'legacy',
      project_id: 'p-doomed',
      resolved_from_cwd: 'E:/app',
      revision_seen: 1,
    });

    projectStore.delete('p-doomed');

    // The workspace survives as scratch and the binding still resolves.
    const after = store.getWorkspace(ws.workspace_id)!;
    expect(after.workspace_id).toBe(ws.workspace_id);
    expect(after.project_id).toBeNull();
    expect(store.getBinding('s-1')!.workspace_id).toBe(ws.workspace_id);
    expect(store.getRoot(root.root_id)!.root_id).toBe(root.root_id);
  });

  it('deleting a workspace cascades to its roots but not to other workspaces', () => {
    const a = store.insertWorkspace({ project_id: 'p-1' });
    const b = store.insertWorkspace({ project_id: 'p-2' });
    store.insertRoot({ workspace_id: a.workspace_id, alias: 'x', canonical_realpath: 'E:/x' });
    const keep = store.insertRoot({ workspace_id: b.workspace_id, alias: 'y', canonical_realpath: 'E:/y' });

    db.prepare('DELETE FROM workspaces WHERE workspace_id = ?').run(a.workspace_id);

    expect(store.listRoots(a.workspace_id)).toEqual([]);
    expect(store.getRoot(keep.root_id)!.root_id).toBe(keep.root_id);
  });

  it('leaves projects.paths byte-identical while workspaces exist', () => {
    const projectStore = new ProjectStore(db);
    const row = projectStore.insert({
      project_id: 'p-paths',
      canonical_root: 'E:/paths-project',
      paths: JSON.stringify([{ path: 'E:/paths-project', description: 'main' }, { path: 'E:/paths-api', description: null }]),
    });
    store.insertWorkspace({ project_id: 'p-paths' });
    const reread = projectStore.get('p-paths')!;
    expect(reread.paths).toBe(row.paths);
    expect(parseProjectPaths(reread.paths)).toEqual([
      { path: 'E:/paths-project', description: 'main' },
      { path: 'E:/paths-api', description: null },
    ]);
  });
});
