/**
 * workspace-store.ts — Workspace identity storage for `duya-core.db`
 * (plan 587 C6.2).
 *
 * V1 Workspace is a device-local UUID identity that MAY bind a Project or be
 * scratch. Roots carry a stable UUID, alias, role, access and a canonical
 * realpath. A `cwd` is a (rootId, relativePath) pair, never a bare string
 * that must be re-resolved from a path.
 *
 * ## Additive, on purpose
 *
 * The `projects` table (plan 534, `project-store.ts`) is the single source of
 * truth for Project identity and is NOT touched by this module: no column is
 * added or dropped, no row is deleted, and no `project_id` is ever re-keyed.
 * `projects.paths` is left exactly as-is and is mapped, not consumed. A
 * rename or a relocate bumps `workspaces.revision`; it never produces a new
 * `workspace_id` or `project_id`.
 *
 * These tables therefore live in the SAME repository and the SAME migration
 * sequence as the `projects` table (next free id after `run-store.ts`'s 37),
 * so there is no second `projects` table and no shadow truth. The 4-column
 * FK-placeholder `projects` shadow inside `memory-state.db` (see
 * `memory-state/catalogSync.ts`) is left alone and is not extended.
 *
 * ## Delete semantics
 *
 * `workspaces.project_id` is `ON DELETE SET NULL` so deleting a Project
 * degrades its Workspace to scratch instead of blocking the existing
 * `deleteProject` path or re-keying anything.
 *
 * `workspace_session_bindings` deliberately carries NO foreign key to
 * `sessions`. A cascade there would silently drop a binding when a session
 * row is replaced (legacy import rewrites session rows), and the next
 * resolution would then mint a *different* Workspace — which is exactly the
 * re-key this module exists to prevent.
 */

import type { Migration, SqliteDatabase } from './database';

/** Effective access a root grants. `none` = revoked, identity row retained. */
export type WorkspaceRootAccess = 'none' | 'read' | 'write';

/** Root role. Defaults to `source`; `primary` is the canonical root. */
export type WorkspaceRootRole = 'primary' | 'source' | 'data';

/**
 * Why a root holds the access it holds — the concrete form of "shows where
 * the grant came from". Read together with `access` it answers "who allowed
 * this, and when was it added".
 *
 *   project_canonical_root — the Project's `canonical_root`. Pre-existing grant.
 *   project_additional_path — a `projects.paths[]` entry beyond the primary.
 *                            Already injected as `additionalDirectories`
 *                            (writable) by `projects:resolveAdditionalRoots`.
 *   session_cwd            — the root a session's cwd pointed at.
 *   user_grant             — granted explicitly by the user.
 *   new_root_default       — added after migration; `access` is `read`.
 *   revoked                — access was withdrawn. `access` is `none`.
 */
export type WorkspaceAccessSource =
  | 'project_canonical_root'
  | 'project_additional_path'
  | 'session_cwd'
  | 'user_grant'
  | 'new_root_default'
  | 'revoked';

/** How a session binding came to exist. `legacy` is the compatibility path. */
export type WorkspaceBindingKind = 'legacy' | 'explicit' | 'migrated';

export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  /** NULL = scratch workspace. Survives Project deletion as `NULL`. */
  project_id: string | null;
  /** Bumped by rename/relocate. Never a substitute for a new workspace_id. */
  revision: number;
  default_root_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRootRow {
  root_id: string;
  workspace_id: string;
  /** Unique within the workspace. */
  alias: string;
  role: WorkspaceRootRole;
  access: WorkspaceRootAccess;
  access_source: WorkspaceAccessSource;
  canonical_realpath: string;
  /** Carried over from the `projects.paths[]` entry it was mapped from. */
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceSessionBindingRow {
  session_id: string;
  workspace_id: string;
  root_id: string | null;
  /** `cwd` = root + this relative path. '' means the root itself. */
  relative_path: string;
  binding_kind: WorkspaceBindingKind;
  /** The Project the resolution went through, for provenance. NULL = scratch. */
  project_id: string | null;
  /**
   * The raw legacy `sessions.working_directory` the binding was derived from.
   * Persisted so a second resolution of the same legacy string is repeatable.
   */
  resolved_from_cwd: string;
  /** Workspace revision observed at bind time. */
  revision_seen: number;
  created_at: number;
  updated_at: number;
}

export interface InsertWorkspaceInput {
  workspace_id?: string;
  name?: string;
  project_id?: string | null;
  revision?: number;
  default_root_id?: string | null;
  created_at?: number;
  updated_at?: number;
}

export interface InsertWorkspaceRootInput {
  root_id?: string;
  workspace_id: string;
  alias: string;
  role?: WorkspaceRootRole;
  access?: WorkspaceRootAccess;
  access_source?: WorkspaceAccessSource;
  canonical_realpath: string;
  description?: string | null;
  created_at?: number;
  updated_at?: number;
}

export interface UpsertWorkspaceBindingInput {
  session_id: string;
  workspace_id: string;
  root_id: string | null;
  relative_path: string;
  binding_kind: WorkspaceBindingKind;
  project_id: string | null;
  resolved_from_cwd: string;
  revision_seen: number;
  created_at?: number;
  updated_at?: number;
}

export class WorkspaceStore {
  /** Migration id=38: workspaces, roots and session bindings. Additive. */
  static readonly migrations: Migration[] = [
    {
      id: 38,
      name: 'create_workspaces',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS workspaces (
            workspace_id    TEXT PRIMARY KEY,
            name            TEXT NOT NULL DEFAULT '',
            project_id      TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
            revision        INTEGER NOT NULL DEFAULT 1,
            default_root_id TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS workspace_roots (
            root_id            TEXT PRIMARY KEY,
            workspace_id       TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
            alias              TEXT NOT NULL,
            role               TEXT NOT NULL DEFAULT 'source',
            access             TEXT NOT NULL DEFAULT 'read',
            access_source      TEXT NOT NULL DEFAULT 'new_root_default',
            canonical_realpath TEXT NOT NULL,
            description        TEXT,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL
          );

          -- No FK to sessions on purpose: see the module header. A binding
          -- must outlive a session row being replaced, or the next
          -- resolution would re-key the Workspace.
          CREATE TABLE IF NOT EXISTS workspace_session_bindings (
            session_id         TEXT PRIMARY KEY,
            workspace_id       TEXT NOT NULL,
            root_id            TEXT,
            relative_path      TEXT NOT NULL DEFAULT '',
            binding_kind       TEXT NOT NULL DEFAULT 'legacy',
            project_id         TEXT,
            resolved_from_cwd  TEXT NOT NULL DEFAULT '',
            revision_seen      INTEGER NOT NULL DEFAULT 0,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_roots_alias
            ON workspace_roots(workspace_id, alias);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_roots_realpath
            ON workspace_roots(workspace_id, canonical_realpath);
          CREATE INDEX IF NOT EXISTS idx_workspaces_project
            ON workspaces(project_id);
          CREATE INDEX IF NOT EXISTS idx_workspace_roots_workspace
            ON workspace_roots(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_workspace_bindings_workspace
            ON workspace_session_bindings(workspace_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get raw(): SqliteDatabase {
    return this.db;
  }

  // ─── workspaces ───

  insertWorkspace(input: InsertWorkspaceInput): WorkspaceRow {
    const now = Date.now();
    const workspaceId = input.workspace_id ?? newUuid();
    this.db
      .prepare(
        `INSERT INTO workspaces (
          workspace_id, name, project_id, revision, default_root_id, created_at, updated_at
        ) VALUES (
          @workspace_id, @name, @project_id, @revision, @default_root_id, @created_at, @updated_at
        )`,
      )
      .run({
        workspace_id: workspaceId,
        name: input.name ?? '',
        project_id: input.project_id ?? null,
        revision: input.revision ?? 1,
        default_root_id: input.default_root_id ?? null,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
      });
    return this.getWorkspace(workspaceId)!;
  }

  getWorkspace(workspaceId: string): WorkspaceRow | null {
    if (!workspaceId) return null;
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ?? null;
  }

  /** The Workspace bound to a Project, or null when the Project has none yet. */
  getWorkspaceByProject(projectId: string): WorkspaceRow | null {
    if (!projectId) return null;
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at LIMIT 1')
      .get(projectId) as WorkspaceRow | undefined;
    return row ?? null;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as WorkspaceRow[];
  }

  setDefaultRoot(workspaceId: string, rootId: string | null, at = Date.now()): boolean {
    const r = this.db
      .prepare('UPDATE workspaces SET default_root_id = @root_id, updated_at = @at WHERE workspace_id = @workspace_id')
      .run({ root_id: rootId, at, workspace_id: workspaceId });
    return Number(r.changes) > 0;
  }

  /**
   * Bump `workspaces.revision`. This is the ONLY thing a rename or relocate
   * does to identity: `workspace_id`, `project_id` and every `root_id` are
   * left untouched.
   */
  bumpRevision(workspaceId: string, at = Date.now()): number {
    this.db
      .prepare('UPDATE workspaces SET revision = revision + 1, updated_at = ? WHERE workspace_id = ?')
      .run(at, workspaceId);
    return this.getWorkspace(workspaceId)?.revision ?? 0;
  }

  // ─── workspace_roots ───

  insertRoot(input: InsertWorkspaceRootInput): WorkspaceRootRow {
    const now = Date.now();
    const rootId = input.root_id ?? newUuid();
    this.db
      .prepare(
        `INSERT INTO workspace_roots (
          root_id, workspace_id, alias, role, access, access_source,
          canonical_realpath, description, created_at, updated_at
        ) VALUES (
          @root_id, @workspace_id, @alias, @role, @access, @access_source,
          @canonical_realpath, @description, @created_at, @updated_at
        )`,
      )
      .run({
        root_id: rootId,
        workspace_id: input.workspace_id,
        alias: input.alias,
        role: input.role ?? 'source',
        access: input.access ?? 'read',
        access_source: input.access_source ?? 'new_root_default',
        canonical_realpath: input.canonical_realpath,
        description: input.description ?? null,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
      });
    return this.getRoot(rootId)!;
  }

  getRoot(rootId: string): WorkspaceRootRow | null {
    if (!rootId) return null;
    const row = this.db
      .prepare('SELECT * FROM workspace_roots WHERE root_id = ?')
      .get(rootId) as WorkspaceRootRow | undefined;
    return row ?? null;
  }

  listRoots(workspaceId: string): WorkspaceRootRow[] {
    return this.db
      .prepare('SELECT * FROM workspace_roots WHERE workspace_id = ? ORDER BY created_at, root_id')
      .all(workspaceId) as WorkspaceRootRow[];
  }

  /** Longest-prefix match: a cwd under any root of this workspace. */
  findRootForCwd(workspaceId: string, normalizedCwd: string): WorkspaceRootRow | null {
    const lower = normalizedCwd.toLowerCase();
    let best: WorkspaceRootRow | null = null;
    for (const root of this.listRoots(workspaceId)) {
      const realpath = root.canonical_realpath.toLowerCase();
      if (lower !== realpath && !lower.startsWith(realpath + '/')) continue;
      if (!best || root.canonical_realpath.length > best.canonical_realpath.length) {
        best = root;
      }
    }
    return best;
  }

  setAccess(
    rootId: string,
    access: WorkspaceRootAccess,
    source: WorkspaceAccessSource,
    at = Date.now(),
  ): boolean {
    const r = this.db
      .prepare('UPDATE workspace_roots SET access = @access, access_source = @source, updated_at = @at WHERE root_id = @root_id')
      .run({ access, source, at, root_id: rootId });
    return Number(r.changes) > 0;
  }

  /**
   * Move a root to a new canonical realpath (rename / relocate).
   *
   * `root_id` and `workspace_id` are preserved, so every session binding that
   * points at this root keeps resolving; only the workspace revision changes.
   */
  relocateRoot(rootId: string, canonicalRealpath: string, at = Date.now()): number {
    const root = this.getRoot(rootId);
    if (!root) throw new Error(`workspace-store: relocateRoot — unknown root_id "${rootId}"`);
    this.db
      .prepare('UPDATE workspace_roots SET canonical_realpath = ?, updated_at = ? WHERE root_id = ?')
      .run(canonicalRealpath, at, rootId);
    return this.bumpRevision(root.workspace_id, at);
  }

  // ─── workspace_session_bindings ───

  /**
   * Insert a binding, or return the existing one untouched when the session
   * already has one. A legacy session's FIRST resolution creates the row and
   * every later resolution is a no-op — that is what makes the mapping
   * repeatable and keeps identity stable across a relocate.
   */
  upsertBinding(input: UpsertWorkspaceBindingInput): {
    row: WorkspaceSessionBindingRow;
    created: boolean;
  } {
    const existing = this.getBinding(input.session_id);
    if (existing) return { row: existing, created: false };
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_session_bindings (
          session_id, workspace_id, root_id, relative_path, binding_kind,
          project_id, resolved_from_cwd, revision_seen, created_at, updated_at
        ) VALUES (
          @session_id, @workspace_id, @root_id, @relative_path, @binding_kind,
          @project_id, @resolved_from_cwd, @revision_seen, @created_at, @updated_at
        )`,
      )
      .run({
        session_id: input.session_id,
        workspace_id: input.workspace_id,
        root_id: input.root_id,
        relative_path: input.relative_path,
        binding_kind: input.binding_kind,
        project_id: input.project_id,
        resolved_from_cwd: input.resolved_from_cwd,
        revision_seen: input.revision_seen,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
      });
    return { row: this.getBinding(input.session_id)!, created: true };
  }

  getBinding(sessionId: string): WorkspaceSessionBindingRow | null {
    if (!sessionId) return null;
    const row = this.db
      .prepare('SELECT * FROM workspace_session_bindings WHERE session_id = ?')
      .get(sessionId) as WorkspaceSessionBindingRow | undefined;
    return row ?? null;
  }

  listBindings(workspaceId: string): WorkspaceSessionBindingRow[] {
    return this.db
      .prepare('SELECT * FROM workspace_session_bindings WHERE workspace_id = ? ORDER BY created_at, session_id')
      .all(workspaceId) as WorkspaceSessionBindingRow[];
  }
}

// Shared with node:crypto (better-sqlite3 runs under CommonJS/Electron).
let _crypto: typeof import('node:crypto') | null = null;
function newUuid(): string {
  const c = _crypto ?? (require('node:crypto') as typeof import('node:crypto'));
  _crypto ??= c;
  return c.randomUUID();
}
