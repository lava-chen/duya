/**
 * workspace-identity.ts — plan 587 C6.2, the Project → Workspace mapping.
 *
 * A Project keeps its `project_id`, its `canonical_root`, its private config
 * and its Memory. What changes is that the Project now has a Workspace
 * identity, and its old `paths[]` have been MAPPED into workspace roots.
 * `projects.paths` is still there, still authoritative for the old readers,
 * and is never rewritten by this module.
 *
 * ## Dry-run first
 *
 * `dryRunWorkspaceIdentity` reports mappings, duplicates, missing paths and
 * conflicts and writes nothing. `applyWorkspaceIdentity` consumes the same
 * plan function, so the two can never disagree about what would change.
 *
 * ## The multi-path decision
 *
 * A multi-path Project becomes exactly ONE Workspace holding the SAME set of
 * roots, in the same order, with the SAME access it already had. That access
 * is not a guess: `projects:resolveAdditionalRoots` (agents/db-bridge.ts)
 * already injects every non-cwd path of a Project into
 * `permissions.additionalDirectories`, i.e. they were all already writable.
 * So every mapped root is `write` and carries the `access_source` that says
 * which existing grant produced it. A root added AFTER the migration defaults
 * to `read` and `new_root_default` — a migration must never widen access.
 *
 * ## What is never touched
 *
 * The `projects` table, `projects.paths`, `project_id`, `canonical_root`, the
 * per-project plans/AGENTS/Memory directories under `~/.duya/projects/<id>/`,
 * and every existing reader (`parseProjectPaths`, `projectPaths`,
 * `findByPath`, `projects:resolveProject`). This module only INSERTs into the
 * three new tables and is idempotent: a Project that already has a Workspace
 * is skipped rather than given a second one.
 */

import * as fs from 'fs';
import { parseProjectPaths, type ProjectRow } from './project-store';
import {
  WorkspaceStore,
  type WorkspaceAccessSource,
  type WorkspaceRootAccess,
  type WorkspaceRootRole,
} from './workspace-store';
import type { SqliteDatabase } from './database';

export interface WorkspaceRootPlan {
  /** The path exactly as stored in `projects` — never re-normalized. */
  path: string;
  alias: string;
  role: WorkspaceRootRole;
  access: WorkspaceRootAccess;
  access_source: WorkspaceAccessSource;
  description: string | null;
  is_canonical_root: boolean;
  /** Set when this entry repeats an earlier path of the same Project. */
  duplicate_of: string | null;
  /** Set when another Project already claims this path. */
  claimed_by_project: string | null;
  /** Probed with `fs.existsSync`; a missing path is still mapped. */
  missing: boolean;
}

export type WorkspaceConflictKind =
  | 'duplicate_within_project'
  | 'path_claimed_by_other_project'
  | 'alias_collision'
  | 'canonical_root_not_in_paths';

export interface WorkspaceConflict {
  kind: WorkspaceConflictKind;
  project_id: string;
  path: string;
  detail: string;
}

export interface WorkspacePlan {
  project_id: string;
  /** Existing workspace id, or null when the migration would mint one. */
  workspace_id: string | null;
  name: string;
  revision: number;
  roots: WorkspaceRootPlan[];
  conflicts: WorkspaceConflict[];
}

export interface WorkspaceMigrationDryRun {
  total_projects: number;
  total_roots: number;
  projects: WorkspacePlan[];
  conflicts: WorkspaceConflict[];
  missing_paths: Array<{ project_id: string; path: string }>;
  duplicate_paths: Array<{ path: string; project_ids: string[] }>;
  /** Projects that would get a new Workspace. */
  would_create_workspaces: number;
  would_create_roots: number;
  /** Projects that already have a Workspace and are therefore skipped. */
  would_skip_projects: string[];
}

export interface WorkspaceMigrationResult {
  created_workspaces: number;
  created_roots: number;
  skipped_projects: string[];
  /** Every `projects` row still present after the migration. */
  projects_after: number;
  /** True when `projects.paths` round-trips byte-identically. */
  projects_untouched: boolean;
}

export interface WorkspaceMigrationOptions {
  /**
   * Filesystem probe for `missing` detection. Off by default so the plan is
   * reproducible in a sandbox; the rehearsal turns it on.
   */
  probeFilesystem?: boolean;
}

/** Read the `projects` rows this module maps. Excludes the FK-placeholder shadow. */
function readProjectRows(db: SqliteDatabase): ProjectRow[] {
  return db
    .prepare('SELECT project_id, canonical_root, name, description, paths, icon, color, created_at, last_seen_at FROM projects')
    .all() as ProjectRow[];
}

function projectsTableExists(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .get();
  return row !== undefined;
}

/**
 * A dry run is most valuable BEFORE the migration has been applied, so it has
 * to tolerate a database that has `projects` but no `workspaces` table yet.
 * Without this guard `getWorkspaceByProject` throws on exactly the pre-migration
 * state the dry run exists to describe.
 */
function workspacesTableExists(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
    .get();
  return row !== undefined;
}

/**
 * Last path segment of a normalized path, lowercased and stripped of
 * characters that would make an awkward alias. Falls back to `root` when the
 * path has no usable basename.
 */
export function deriveAlias(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const base = segments[segments.length - 1] ?? '';
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'root';
}

/** Case-insensitive on Windows-style paths, exact elsewhere. */
function pathKey(path: string): string {
  return path.toLowerCase();
}

/**
 * The Project's root list. A Project created through `createProject` has
 * `paths[0] === canonical_root`; one created through `registerProject`
 * (memory-state/projectResolver.ts) has a single entry that IS its canonical
 * root. A row with an empty `paths` still has a `canonical_root` and must not
 * be dropped, so it falls back to a single root.
 */
function projectRootPaths(row: ProjectRow): Array<{ path: string; description: string | null }> {
  const entries = parseProjectPaths(row.paths);
  if (entries.length > 0) return entries;
  if (row.canonical_root) return [{ path: row.canonical_root, description: null }];
  return [];
}

/**
 * Compute the full plan without writing. Idempotent: a Project that already
 * has a Workspace is reported with its `workspace_id` and contributes no new
 * roots, so running the migration twice is a no-op.
 */
export function dryRunWorkspaceIdentity(
  db: SqliteDatabase,
  opts: WorkspaceMigrationOptions = {},
): WorkspaceMigrationDryRun {
  const probeFs = opts.probeFilesystem === true;
  const store = new WorkspaceStore(db);

  if (!projectsTableExists(db)) {
    return {
      total_projects: 0,
      total_roots: 0,
      projects: [],
      conflicts: [],
      missing_paths: [],
      duplicate_paths: [],
      would_create_workspaces: 0,
      would_create_roots: 0,
      would_skip_projects: [],
    };
  }

  const rows = readProjectRows(db);
  const hasWorkspaces = workspacesTableExists(db);

  // Pass 1: which Project claims each path. Drives cross-project conflicts.
  const claims = new Map<string, string[]>();
  for (const row of rows) {
    for (const entry of projectRootPaths(row)) {
      const key = pathKey(entry.path);
      const list = claims.get(key);
      if (list) list.push(row.project_id);
      else claims.set(key, [row.project_id]);
    }
  }

  const conflicts: WorkspaceConflict[] = [];
  const missingPaths: Array<{ project_id: string; path: string }> = [];
  const plans: WorkspacePlan[] = [];
  const wouldSkip: string[] = [];
  let wouldCreateWorkspaces = 0;
  let wouldCreateRoots = 0;

  for (const row of rows) {
    const existing = hasWorkspaces ? store.getWorkspaceByProject(row.project_id) : null;
    const projectConflicts: WorkspaceConflict[] = [];

    if (existing) {
      wouldSkip.push(row.project_id);
      plans.push({
        project_id: row.project_id,
        workspace_id: existing.workspace_id,
        name: existing.name,
        revision: existing.revision,
        roots: [],
        conflicts: [],
      });
      continue;
    }

    wouldCreateWorkspaces += 1;
    const entries = projectRootPaths(row);
    const canonicalKey = pathKey(row.canonical_root);

    if (entries.length > 0 && !entries.some((e) => pathKey(e.path) === canonicalKey)) {
      // `canonical_root` is absent from `paths[]`. Both are real grants, so
      // both are mapped and the divergence is reported rather than guessed.
      projectConflicts.push({
        kind: 'canonical_root_not_in_paths',
        project_id: row.project_id,
        path: row.canonical_root,
        detail:
          'canonical_root is not present in projects.paths; mapped as an additional root. ' +
          'projects.paths is left unchanged, so old readers still see the old list.',
      });
    }

    const seenWithin = new Map<string, string>();
    const usedAliases = new Set<string>();
    const roots: WorkspaceRootPlan[] = [];

    // The canonical root is mapped first so the Workspace has a primary root
    // even when `paths[]` lists it in an arbitrary position. Its description
    // is taken from the `paths[]` entry that carries it — the synthetic
    // canonical entry has none of its own and would otherwise win the dedupe
    // and drop the user's description.
    //
    // A leading `paths[0]` that IS the canonical root is the normal shape of
    // every row written by `createProject` (which derives `canonical_root`
    // from `paths[0]`) and of every row written by `registerProject`. It is
    // consumed silently: reporting it as a duplicate would put a
    // `duplicate_within_project` conflict on literally every healthy project
    // and bury the conflicts that matter.
    const tailEntries = entries[0] && pathKey(entries[0].path) === canonicalKey ? entries.slice(1) : entries;
    const ordered = [
      {
        path: row.canonical_root,
        description: entries.find((e) => pathKey(e.path) === canonicalKey)?.description ?? null,
        primary: true,
      },
      ...tailEntries.map((e) => ({ path: e.path, description: e.description, primary: false })),
    ].filter((e) => e.path.length > 0);

    for (const entry of ordered) {
      const key = pathKey(entry.path);

      if (seenWithin.has(key)) {
        projectConflicts.push({
          kind: 'duplicate_within_project',
          project_id: row.project_id,
          path: entry.path,
          detail: `duplicate of "${seenWithin.get(key)}" in the same Project; collapsed to one root`,
        });
        continue;
      }
      seenWithin.set(key, entry.path);

      const claimers = claims.get(key) ?? [];
      const foreign = claimers.filter((id) => id !== row.project_id);
      if (foreign.length > 0) {
        projectConflicts.push({
          kind: 'path_claimed_by_other_project',
          project_id: row.project_id,
          path: entry.path,
          detail: `path is also claimed by project(s) ${foreign.join(', ')}; existing registration order is preserved`,
        });
      }

      let alias = deriveAlias(entry.path);
      if (usedAliases.has(alias)) {
        const base = alias;
        let n = 2;
        while (usedAliases.has(`${base}-${n}`)) n += 1;
        alias = `${base}-${n}`;
        projectConflicts.push({
          kind: 'alias_collision',
          project_id: row.project_id,
          path: entry.path,
          detail: `alias "${base}" was already used in this Workspace; suffixed to "${alias}"`,
        });
      }
      usedAliases.add(alias);

      const missing = probeFs ? !fs.existsSync(entry.path) : false;
      if (missing) {
        missingPaths.push({ project_id: row.project_id, path: entry.path });
      }

      roots.push({
        path: entry.path,
        alias,
        role: entry.primary ? 'primary' : 'source',
        // Pre-existing grant: every Project path was already an effective
        // writable root via additionalDirectories. Preserved, not widened.
        access: 'write',
        access_source: entry.primary ? 'project_canonical_root' : 'project_additional_path',
        description: entry.description,
        is_canonical_root: entry.primary,
        duplicate_of: null,
        claimed_by_project: foreign.length > 0 ? foreign[0] : null,
        missing,
      });
    }

    wouldCreateRoots += roots.length;
    conflicts.push(...projectConflicts);
    plans.push({
      project_id: row.project_id,
      workspace_id: null,
      name: row.name,
      revision: 1,
      roots,
      conflicts: projectConflicts,
    });
  }

  const duplicatePaths = [...claims.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => {
      // Report the path in its original casing, not the comparison key.
      for (const row of rows) {
        const hit = projectRootPaths(row).find((e) => pathKey(e.path) === key);
        if (hit) return { path: hit.path, project_ids: [...new Set(ids)] };
      }
      return { path: key, project_ids: [...new Set(ids)] };
    });

  return {
    total_projects: rows.length,
    total_roots: plans.reduce((n, p) => n + p.roots.length, 0),
    projects: plans,
    conflicts,
    missing_paths: missingPaths,
    duplicate_paths: duplicatePaths,
    would_create_workspaces: wouldCreateWorkspaces,
    would_create_roots: wouldCreateRoots,
    would_skip_projects: wouldSkip,
  };
}

/**
 * Create the Workspace for exactly one Project, using the same plan function
 * as the bulk migration so there is one mapping rule and not two.
 *
 * Returns `null` when the Project already has a Workspace (the caller then
 * reads the existing one) or when the Project has no usable root at all.
 */
export function ensureWorkspaceForProject(
  db: SqliteDatabase,
  projectId: string,
  opts: WorkspaceMigrationOptions = {},
): string | null {
  const store = new WorkspaceStore(db);
  const existing = store.getWorkspaceByProject(projectId);
  if (existing) return null;

  const plan = dryRunWorkspaceIdentity(db, opts);
  const projectPlan = plan.projects.find((p) => p.project_id === projectId);
  if (!projectPlan || projectPlan.roots.length === 0) return null;

  const workspace = store.insertWorkspace({
    name: projectPlan.name,
    project_id: projectId,
    revision: projectPlan.revision,
  });
  let defaultRootId: string | null = null;
  for (const root of projectPlan.roots) {
    const row = store.insertRoot({
      workspace_id: workspace.workspace_id,
      alias: root.alias,
      role: root.role,
      access: root.access,
      access_source: root.access_source,
      canonical_realpath: root.path,
      description: root.description,
    });
    if (root.is_canonical_root || defaultRootId === null) defaultRootId = row.root_id;
  }
  if (defaultRootId !== null) store.setDefaultRoot(workspace.workspace_id, defaultRootId);
  return workspace.workspace_id;
}

/**
 * Apply the mapping. Wraps everything in one `BEGIN IMMEDIATE` transaction and
 * verifies afterwards that every `projects` row — and every `paths` payload —
 * is byte-identical to what it was before, so a migration can never be the
 * thing that loses a Project's private data.
 */
export function applyWorkspaceIdentity(
  db: SqliteDatabase,
  opts: WorkspaceMigrationOptions = {},
): WorkspaceMigrationResult {
  const plan = dryRunWorkspaceIdentity(db, opts);
  const store = new WorkspaceStore(db);

  const projectsBefore = readProjectRows(db);
  const pathsBefore = new Map(projectsBefore.map((r) => [r.project_id, r.paths]));

  db.exec('BEGIN IMMEDIATE');
  try {
    let createdWorkspaces = 0;
    let createdRoots = 0;
    const skipped: string[] = [];

    for (const projectPlan of plan.projects) {
      if (projectPlan.workspace_id !== null) {
        skipped.push(projectPlan.project_id);
        continue;
      }
      const workspace = store.insertWorkspace({
        name: projectPlan.name,
        project_id: projectPlan.project_id,
        revision: projectPlan.revision,
      });
      createdWorkspaces += 1;

      let defaultRootId: string | null = null;
      for (const root of projectPlan.roots) {
        const row = store.insertRoot({
          workspace_id: workspace.workspace_id,
          alias: root.alias,
          role: root.role,
          access: root.access,
          access_source: root.access_source,
          canonical_realpath: root.path,
          description: root.description,
        });
        createdRoots += 1;
        if (root.is_canonical_root || defaultRootId === null) defaultRootId = row.root_id;
      }
      if (defaultRootId !== null) store.setDefaultRoot(workspace.workspace_id, defaultRootId);
    }

    // Loss check: the Project layer is untouched.
    const projectsAfter = readProjectRows(db);
    if (projectsAfter.length !== projectsBefore.length) {
      throw new Error(
        `workspace-identity: project count changed ${projectsBefore.length} -> ${projectsAfter.length}; aborting`,
      );
    }
    for (const row of projectsAfter) {
      if (pathsBefore.get(row.project_id) !== row.paths) {
        throw new Error(
          `workspace-identity: projects.paths for "${row.project_id}" changed during migration; aborting`,
        );
      }
    }

    db.exec('COMMIT');
    return {
      created_workspaces: createdWorkspaces,
      created_roots: createdRoots,
      skipped_projects: skipped,
      projects_after: projectsAfter.length,
      projects_untouched: true,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Connection already unwound — nothing to roll back.
    }
    throw err;
  }
}
