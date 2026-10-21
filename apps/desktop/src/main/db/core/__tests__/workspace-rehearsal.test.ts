/**
 * workspace-rehearsal.test.ts — plan 587 C6.2.
 *
 * A migration that has never been run against a copied database is not a
 * migration. This suite builds a realistic corpus, CLOSES it, copies the
 * file to a second location, reopens the COPY, migrates the copy, and then
 * exercises the old reader, the new reader, a reopen and a relocate against
 * it. The original file is never migrated, so a bug here cannot damage a
 * user's database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, parseProjectPaths, serializeProjectPaths } from '../project-store';
import { WorkspaceStore } from '../workspace-store';
import { applyWorkspaceIdentity, dryRunWorkspaceIdentity } from '../workspace-identity';
import { resolveWorkspaceBinding } from '../workspace-resolver';
import { normalizePath } from '../../../memory-state/pathUtils';
import type { SqliteDatabase } from '../database';

/**
 * Map a Windows-style fixture path onto the current platform.
 *
 * The resolver calls the HOST `path.resolve`, so a drive letter is not a
 * root on POSIX: such a path is relative, gets rebased onto the runner CWD,
 * and the suite then compares a cwd-prefixed path against a raw fixture
 * string. `fx` returns the Windows form on win32 (so drive-letter handling
 * stays asserted) and a genuine absolute path everywhere else.
 */
const IS_WIN = process.platform === 'win32';
function fx(p: string): string {
  if (IS_WIN) return p;
  return '/' + p.replace(/^[A-Za-z]:[\\/]/, '').replace(/\\/g, '/');
}

let nativeSqliteAvailable = true;
try {
  new Database(':memory:').close();
} catch {
  nativeSqliteAvailable = false;
}

function openDb(file: string): SqliteDatabase {
  const db = new Database(file) as unknown as SqliteDatabase;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const m of ProjectStore.migrations) m.up(db);
  for (const m of WorkspaceStore.migrations) m.up(db);
  return db;
}

describe.skipIf(!nativeSqliteAvailable)('workspace migration rehearsal', () => {
  let root: string;
  let sourceFile: string;
  let cloneFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ws-rehearsal-'));
    sourceFile = path.join(root, 'duya-core-source.db');
    cloneFile = path.join(root, 'duya-core-clone.db');
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /**
   * A realistic corpus: a multi-path project, a single-path project, a
   * project whose paths[] is empty, a project with a description, a
   * directory that is genuinely absent, and a path claimed twice.
   *
   * Returns the normalized realpath of the one root that exists on disk.
   */
  function buildCorpus(file: string): string {
    const db = openDb(file);
    const projects = new ProjectStore(db);

    const realDir = path.join(root, 'live');
    fs.mkdirSync(realDir, { recursive: true });
    // Seed exactly what the storage side stores: a normalized path.
    const realDirRealpath = normalizePath(fs.realpathSync.native(realDir)).absolute_normalized_path;

    projects.insert({
      project_id: 'p-multi',
      canonical_root: fx('E:/repos/duya'),
      name: 'duya',
      description: 'main monorepo',
      paths: serializeProjectPaths([
        { path: fx('E:/repos/duya'), description: 'primary' },
        { path: fx('E:/repos/duya-site'), description: 'marketing site' },
        { path: fx('E:/repos/duya'), description: 'duplicate entry' },
      ]),
    });
    projects.insert({
      project_id: 'p-single',
      canonical_root: fx('E:/repos/solo'),
      name: 'solo',
      paths: serializeProjectPaths([{ path: fx('E:/repos/solo'), description: null }]),
    });
    projects.insert({ project_id: 'p-bare', canonical_root: fx('E:/repos/bare'), name: 'bare' });
    projects.insert({
      project_id: 'p-missing',
      canonical_root: fx('E:/repos/unmounted'),
      paths: serializeProjectPaths([{ path: fx('E:/repos/unmounted'), description: null }]),
    });
    projects.insert({
      project_id: 'p-clash',
      canonical_root: fx('E:/repos/shared'),
      paths: serializeProjectPaths([
        { path: fx('E:/repos/shared'), description: null },
        { path: fx('E:/repos/duya'), description: 'borrowed' },
      ]),
    });
    projects.insert({
      project_id: 'p-live',
      canonical_root: realDirRealpath,
      name: 'live',
      paths: serializeProjectPaths([{ path: realDirRealpath, description: 'on disk' }]),
    });

    // Per-project private storage that the migration must not touch.
    const home = path.join(root, 'projects', 'p-multi');
    fs.mkdirSync(path.join(home, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(home, 'plans', 'index.json'), '{"plans":[{"id":"587"}]}');
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# duya project agents');

    db.close();
    return realDirRealpath;
  }

  it('dry-run on the clone reports mappings, duplicates, missing paths and conflicts', () => {
    const realDirRealpath = buildCorpus(sourceFile);
    fs.copyFileSync(sourceFile, cloneFile);
    const db = openDb(cloneFile);

    const plan = dryRunWorkspaceIdentity(db, { probeFilesystem: true });

    expect(plan.total_projects).toBe(6);
    expect(plan.would_create_workspaces).toBe(6);
    // p-multi 3 entries with 1 collapsed to 2 roots, then 1 + 1 + 1 + 2 + 1.
    expect(plan.would_create_roots).toBe(8);
    expect(plan.total_roots).toBe(8);

    expect(plan.duplicate_paths.map((d) => d.path)).toContain(fx('E:/repos/duya'));
    expect(
      plan.duplicate_paths.find((d) => d.path === fx('E:/repos/duya'))!.project_ids.sort(),
    ).toEqual(['p-clash', 'p-multi']);

    // One entry per mapped root that is not on disk. The corpus has no `E:/`
    // directory, so every seeded E:/ root is missing; p-clash claims
    // `E:/repos/duya` as well, which is why the path repeats.
    expect(plan.missing_paths.map((m) => `${m.project_id}:${m.path}`).sort()).toEqual(
      [
        'p-clash:E:/repos/duya',
        'p-clash:E:/repos/shared',
        'p-missing:E:/repos/unmounted',
        'p-multi:E:/repos/duya',
        'p-multi:E:/repos/duya-site',
        'p-single:E:/repos/solo',
        'p-bare:E:/repos/bare',
      ].sort(),
    );
    // The one root that really is on disk is not reported.
    expect(plan.missing_paths.some((m) => m.path === realDirRealpath)).toBe(false);

    const kinds = new Set(plan.conflicts.map((c) => c.kind));
    expect(kinds).toContain('duplicate_within_project');
    expect(kinds).toContain('path_claimed_by_other_project');

    db.close();
  });

  it('the source file is untouched; only the clone is migrated', () => {
    buildCorpus(sourceFile);
    fs.copyFileSync(sourceFile, cloneFile);

    const sourceBefore = fs.readFileSync(sourceFile);
    const clone = openDb(cloneFile);
    const result = applyWorkspaceIdentity(clone, { probeFilesystem: true });
    expect(result.created_workspaces).toBe(6);
    clone.close();

    // The source never had a workspaces table written to it.
    expect(fs.readFileSync(sourceFile).equals(sourceBefore)).toBe(true);
    const sourceDb = openDb(sourceFile);
    expect(new WorkspaceStore(sourceDb).listWorkspaces()).toEqual([]);
    expect(new ProjectStore(sourceDb).list()).toHaveLength(6);
    sourceDb.close();
  });

  it('old reader, new reader, reopen and relocate all hold on the migrated clone', () => {
    buildCorpus(sourceFile);
    fs.copyFileSync(sourceFile, cloneFile);

    // ── migrate the clone ──────────────────────────────────────────────
    let db = openDb(cloneFile);
    const pathsBefore = new Map(
      new ProjectStore(db).list().map((r) => [r.project_id, r.paths]),
    );
    applyWorkspaceIdentity(db, { probeFilesystem: true });

    // ── 1. OLD reader, before reopen ────────────────────────────────────
    const oldProjects = new ProjectStore(db);
    const multi = oldProjects.get('p-multi')!;
    expect(multi.paths).toBe(pathsBefore.get('p-multi'));
    expect(multi.canonical_root).toBe(fx('E:/repos/duya'));
    expect(parseProjectPaths(multi.paths)).toEqual([
      { path: fx('E:/repos/duya'), description: 'primary' },
      { path: fx('E:/repos/duya-site'), description: 'marketing site' },
      { path: fx('E:/repos/duya'), description: 'duplicate entry' },
    ]);
    // The old reverse lookup still answers exactly as before.
    expect(oldProjects.findByPath(fx('E:/repos/duya'))!.project_id).toBe('p-multi');
    expect(oldProjects.findByPath(fx('E:/repos/duya-site'))!.project_id).toBe('p-multi');
    expect(oldProjects.findByPath(fx('E:/repos/solo'))!.project_id).toBe('p-single');
    // The old additionalDirectories fan-out is unchanged. Mirrors the dedupe
    // in `projects:resolveAdditionalRoots`, so the duplicate entry collapses.
    const allPaths = parseProjectPaths(multi.paths).map((e) => e.path);
    const cwdNorm = fx('E:/repos/duya');
    const seen = new Set([cwdNorm.toLowerCase()]);
    const additionalRoots: string[] = [];
    for (const p of allPaths) {
      if (seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      additionalRoots.push(p);
    }
    expect(additionalRoots).toEqual([fx('E:/repos/duya-site')]);

    // ── 2. NEW reader, before reopen ────────────────────────────────────
    const wsStore = new WorkspaceStore(db);
    const ws = wsStore.getWorkspaceByProject('p-multi')!;
    expect(ws).not.toBeNull();
    expect(ws.revision).toBe(1);
    const roots = wsStore.listRoots(ws.workspace_id);
    expect(roots.map((r) => r.canonical_realpath).sort()).toEqual([fx('E:/repos/duya'), fx('E:/repos/duya-site')]);
    expect(roots.find((r) => r.role === 'primary')!.access_source).toBe('project_canonical_root');
    expect(roots.find((r) => r.role === 'primary')!.description).toBe('primary');

    const bound = resolveWorkspaceBinding({ db, sessionId: 'rehearsal-1', cwd: fx('E:/repos/duya/apps/desktop') });
    expect(bound.status).toBe('bound');
    expect(bound.binding!.project_id).toBe('p-multi');
    expect(bound.binding!.relative_path).toBe('apps/desktop');

    const orphaned = resolveWorkspaceBinding({ db, sessionId: 'rehearsal-none', cwd: fx('E:/totally/unrelated') });
    expect(orphaned.status).toBe('no_workspace');

    db.close();

    // ── 3. REOPEN the migrated clone ────────────────────────────────────
    db = openDb(cloneFile);
    const reopenedProjects = new ProjectStore(db);
    const reopenedWs = new WorkspaceStore(db);

    // Old reader after reopen.
    expect(reopenedProjects.get('p-multi')!.paths).toBe(pathsBefore.get('p-multi'));
    expect(reopenedProjects.findByPath(fx('E:/repos/duya-site'))!.project_id).toBe('p-multi');
    expect(reopenedProjects.list()).toHaveLength(6);

    // New reader after reopen — the binding survived the close/reopen.
    const reopenedBound = resolveWorkspaceBinding({
      db,
      sessionId: 'rehearsal-1',
      cwd: fx('E:/repos/duya/apps/desktop'),
    });
    expect(reopenedBound.status).toBe('existing');
    expect(reopenedBound.workspace!.workspace_id).toBe(ws.workspace_id);
    expect(reopenedBound.root!.root_id).toBe(bound.root!.root_id);
    expect(reopenedWs.getBinding('rehearsal-1')!.relative_path).toBe('apps/desktop');

    // ── 4. RELOCATE a root ──────────────────────────────────────────────
    const primaryRoot = roots.find((r) => r.role === 'primary')!;
    const revision = reopenedWs.relocateRoot(primaryRoot.root_id, fx('E:/repos/duya-renamed'));
    expect(revision).toBe(2);

    // Identity did not move.
    expect(reopenedWs.getWorkspace(ws.workspace_id)!.project_id).toBe('p-multi');
    expect(reopenedWs.getRoot(primaryRoot.root_id)!.canonical_realpath).toBe(fx('E:/repos/duya-renamed'));
    const afterRelocate = resolveWorkspaceBinding({
      db,
      sessionId: 'rehearsal-1',
      cwd: fx('E:/repos/duya/apps/desktop'),
    });
    expect(afterRelocate.status).toBe('existing');
    expect(afterRelocate.workspace!.workspace_id).toBe(ws.workspace_id);
    expect(afterRelocate.root!.root_id).toBe(primaryRoot.root_id);
    expect(afterRelocate.resolved_cwd).toBe(fx('E:/repos/duya-renamed/apps/desktop'));
    expect(reopenedWs.listWorkspaces()).toHaveLength(6);

    // Old reader after relocate: `projects` is still exactly as it was, so a
    // downgrade to the old binary keeps working off the old path list.
    expect(reopenedProjects.get('p-multi')!.paths).toBe(pathsBefore.get('p-multi'));
    expect(reopenedProjects.findByPath(fx('E:/repos/duya'))!.project_id).toBe('p-multi');

    db.close();
  });

  it('a second migrate of the reopened clone is a no-op', () => {
    buildCorpus(sourceFile);
    fs.copyFileSync(sourceFile, cloneFile);

    let db = openDb(cloneFile);
    applyWorkspaceIdentity(db, { probeFilesystem: true });
    db.close();

    db = openDb(cloneFile);
    const second = applyWorkspaceIdentity(db, { probeFilesystem: true });
    expect(second.created_workspaces).toBe(0);
    expect(second.created_roots).toBe(0);
    expect(second.skipped_projects).toHaveLength(6);
    expect(new WorkspaceStore(db).listWorkspaces()).toHaveLength(6);
    db.close();
  });

  it('the project private plans and AGENTS.md survive the rehearsal', () => {
    buildCorpus(sourceFile);
    fs.copyFileSync(sourceFile, cloneFile);

    const db = openDb(cloneFile);
    applyWorkspaceIdentity(db, { probeFilesystem: true });
    db.close();

    const home = path.join(root, 'projects', 'p-multi');
    expect(fs.readFileSync(path.join(home, 'plans', 'index.json'), 'utf8')).toBe('{"plans":[{"id":"587"}]}');
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('# duya project agents');
  });
});
