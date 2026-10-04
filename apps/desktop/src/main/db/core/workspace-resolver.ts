/**
 * workspace-resolver.ts — plan 587 C6.2, the compatibility resolver.
 *
 * A legacy session stores a bare `working_directory` string. Under the
 * Workspace model a `cwd` is a (rootId, relativePath) pair. This resolver is
 * the one place that turns the old form into the new one, and it does so
 * LAZILY: a legacy session's FIRST explicit resolution writes a binding with
 * `binding_kind = 'legacy'`, and every later resolution of that session
 * returns the same binding without writing.
 *
 * That laziness is the whole point. Because the binding is keyed by
 * `session_id` and not by path, moving a directory cannot re-key anything: a
 * relocate updates `workspace_roots.canonical_realpath` and bumps
 * `workspaces.revision`, the binding keeps its `root_id`, and the session
 * still resolves — to the new location, under the same identity.
 *
 * `normalizePath` is imported from the existing `memory-state/pathUtils`
 * (a leaf module) rather than reimplemented, so there is exactly one
 * normalization algorithm in the tree and a legacy cwd normalizes to the same
 * string the storage side produced.
 */

import * as fs from 'fs';
import { normalizePath } from '../../memory-state/pathUtils';
import { ProjectStore, parseProjectPaths, type ProjectRow } from './project-store';
import { ensureWorkspaceForProject } from './workspace-identity';
import {
  WorkspaceStore,
  type WorkspaceRootRow,
  type WorkspaceSessionBindingRow,
  type WorkspaceRow,
} from './workspace-store';
import type { SqliteDatabase } from './database';

export interface ResolveWorkspaceBindingInput {
  db: SqliteDatabase;
  sessionId: string;
  /** The legacy `sessions.working_directory`, or an explicit workspace root. */
  cwd: string;
  /** Probe the filesystem to report a missing root. Off by default. */
  probeFilesystem?: boolean;
}

export interface GrantedRoot {
  root_id: string;
  alias: string;
  access: string;
  access_source: string;
  canonical_realpath: string;
}

export type WorkspaceBindingStatus =
  /** First resolution of this session; a legacy binding was just written. */
  | 'bound'
  /** A binding already existed and was returned unchanged. */
  | 'existing'
  /** Nothing claims this cwd — a session with no Project. */
  | 'no_workspace';

export interface WorkspaceBindingResolution {
  status: WorkspaceBindingStatus;
  binding: WorkspaceSessionBindingRow | null;
  workspace: WorkspaceRow | null;
  /** The root backing the binding, or null when bound to the workspace itself. */
  root: WorkspaceRootRow | null;
  /**
   * The cwd reconstructed from (root, relative_path) at the root's CURRENT
   * realpath. After a relocate this is the new location, not the legacy one.
   */
  resolved_cwd: string;
  /** The legacy string the binding was derived from, for traceability. */
  legacy_cwd: string;
  /** Roots the session may actually use, with their grant provenance. */
  granted_roots: GrantedRoot[];
  /** The binding's own root is no longer on disk. */
  root_missing: boolean;
  /** The binding's own root has had its access withdrawn (`access = 'none'`). */
  root_revoked: boolean;
  /** Human-readable notes: path claimed by two Projects, workspace created, etc. */
  notes: string[];
}

/**
 * `cwd` relative to `root`. '' when they are the same directory or when
 * `cwd` is not under `root` at all — callers confirm the match with
 * `cwdWithinRoot` first, so the two cases never need distinguishing here.
 */
export function relativePathWithin(root: string, cwd: string): string {
  const r = driveKey(root);
  const c = driveKey(cwd);
  if (c === r) return '';
  if (c.startsWith(r + '/')) return c.slice(r.length + 1);
  return '';
}

/** Rejoin (root, relative) back into an absolute normalized path. */
export function absolutePathFromRoot(root: string, relativePath: string): string {
  if (relativePath === '') return root;
  return root.replace(/\/+$/, '') + '/' + relativePath.replace(/^\/+/, '');
}

/** True when `cwd` is the root itself or lives under it. */
function cwdWithinRoot(cwd: string, realpath: string): boolean {
  const c = driveKey(cwd);
  const r = driveKey(realpath);
  return c === r || c.startsWith(r + '/');
}

/**
 * Comparison key that folds only the Windows drive letter.
 *
 * `normalizePath` lowercases the drive letter, but a `projects.paths` payload
 * written before that rule landed (or seeded by an older tool) can still carry
 * `E:/...`. Folding the drive letter on both sides makes the resolver tolerant
 * of that without making POSIX paths case-insensitive.
 */
function driveKey(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = p.match(/^([A-Za-z]):(\/.*)$/);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : p;
}

/**
 * Longest-prefix root match across every root of the given workspaces.
 * Ties break on the longer realpath, so a nested root wins over its parent.
 */
function findRootAcross(workspaces: WorkspaceRow[], store: WorkspaceStore, cwd: string): WorkspaceRootRow | null {
  let best: WorkspaceRootRow | null = null;
  for (const workspace of workspaces) {
    for (const root of store.listRoots(workspace.workspace_id)) {
      if (!cwdWithinRoot(cwd, root.canonical_realpath)) continue;
      if (!best || root.canonical_realpath.length > best.canonical_realpath.length) best = root;
    }
  }
  return best;
}

/**
 * Find the Project whose `projects.paths` (or `canonical_root`) is a
 * longest-prefix match for the cwd. Used only when a cwd has no Workspace yet
 * — the compatibility path for a Project that was never bulk-migrated.
 */
function findProjectForCwd(projects: ProjectRow[], cwd: string): ProjectRow | null {
  let best: { row: ProjectRow; len: number } | null = null;
  for (const row of projects) {
    const candidates = [row.canonical_root, ...parseProjectPaths(row.paths).map((e) => e.path)];
    for (const candidate of candidates) {
      if (!candidate || !cwdWithinRoot(cwd, candidate)) continue;
      if (!best || candidate.length > best.len) best = { row, len: candidate.length };
    }
  }
  return best?.row ?? null;
}

function collectGranted(store: WorkspaceStore, workspaceId: string): GrantedRoot[] {
  return store
    .listRoots(workspaceId)
    .filter((root) => root.access !== 'none')
    .map((root) => ({
      root_id: root.root_id,
      alias: root.alias,
      access: root.access,
      access_source: root.access_source,
      canonical_realpath: root.canonical_realpath,
    }));
}

function unbound(cwd: string, notes: string[]): WorkspaceBindingResolution {
  return {
    status: 'no_workspace',
    binding: null,
    workspace: null,
    root: null,
    resolved_cwd: cwd,
    legacy_cwd: cwd,
    granted_roots: [],
    root_missing: false,
    root_revoked: false,
    notes,
  };
}

/**
 * Resolve a session's cwd to a Workspace binding, creating a legacy binding on
 * first sight. Idempotent and repeatable: calling it twice with the same
 * `sessionId` writes once and then always returns the first binding.
 */
export function resolveWorkspaceBinding(
  input: ResolveWorkspaceBindingInput,
): WorkspaceBindingResolution {
  const { db, sessionId } = input;
  const rawCwd = (input.cwd ?? '').trim();
  if (!sessionId || !rawCwd) {
    return unbound(rawCwd, ['no session id or cwd supplied; nothing to bind']);
  }

  const store = new WorkspaceStore(db);
  const cwd = normalizePath(rawCwd).absolute_normalized_path;
  const notes: string[] = [];

  // 1. An existing binding always wins. This is what makes a rename or a
  //    relocate a revision instead of a re-key: the session keeps its
  //    workspace and its root_id no matter where the directory moved to.
  const existing = store.getBinding(sessionId);
  if (existing) {
    const workspace = store.getWorkspace(existing.workspace_id);
    const root = existing.root_id ? store.getRoot(existing.root_id) : null;
    const resolvedCwd = root
      ? absolutePathFromRoot(root.canonical_realpath, existing.relative_path)
      : cwd;
    if (root && root.access === 'none') notes.push('root access is revoked (access = none)');
    return {
      status: 'existing',
      binding: existing,
      workspace,
      root,
      resolved_cwd: resolvedCwd,
      legacy_cwd: existing.resolved_from_cwd || rawCwd,
      granted_roots: collectGranted(store, existing.workspace_id),
      root_missing: input.probeFilesystem === true ? !fs.existsSync(resolvedCwd) : false,
      root_revoked: root?.access === 'none',
      notes,
    };
  }

  // 2. First resolution. Try the Workspace layer first.
  let workspaces = store.listWorkspaces();
  let root = findRootAcross(workspaces, store, cwd);
  let projectId: string | null = null;

  if (!root) {
    // 3. Compatibility path: no Workspace claims the cwd. Ask the Project
    //    layer, and mint a Workspace for the owning Project on the spot using
    //    the same mapping rule as the bulk migration.
    const projects = new ProjectStore(db).list();
    const project = findProjectForCwd(projects, cwd);
    if (!project) {
      return unbound(cwd, [
        'no project root claims this cwd; session is not bound to a workspace',
      ]);
    }
    projectId = project.project_id;
    notes.push(`project ${project.project_id} had no workspace; created one on first resolution`);
    ensureWorkspaceForProject(db, project.project_id, {
      probeFilesystem: input.probeFilesystem === true,
    });
    workspaces = store.listWorkspaces();
    root = findRootAcross(workspaces, store, cwd);
  }

  if (!root) {
    return unbound(cwd, [
      'project matched but no root covers this cwd; not bound',
    ]);
  }

  const workspace = store.getWorkspace(root.workspace_id);
  if (!workspace) {
    return unbound(cwd, ['root has no workspace row; not bound']);
  }
  projectId = projectId ?? workspace.project_id;

  const relativePath = relativePathWithin(root.canonical_realpath, cwd);
  const { row } = store.upsertBinding({
    session_id: sessionId,
    workspace_id: workspace.workspace_id,
    root_id: root.root_id,
    relative_path: relativePath,
    binding_kind: 'legacy',
    project_id: projectId,
    resolved_from_cwd: rawCwd,
    revision_seen: workspace.revision,
  });

  if (input.probeFilesystem === true && !fs.existsSync(cwd)) {
    notes.push('cwd does not exist on disk; binding kept so identity survives');
  }
  if (root.access === 'none') notes.push('root access is revoked (access = none)');
  if (relativePath !== '') notes.push(`cwd is ${relativePath} below root ${root.alias}`);

  return {
    status: 'bound',
    binding: row,
    workspace,
    root,
    resolved_cwd: cwd,
    legacy_cwd: rawCwd,
    granted_roots: collectGranted(store, workspace.workspace_id),
    root_missing: input.probeFilesystem === true ? !fs.existsSync(cwd) : false,
    root_revoked: root.access === 'none',
    notes,
  };
}
