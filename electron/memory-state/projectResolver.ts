import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { loadWorkspaceOverrides, type WorkspaceOverride } from './workspaceOverrides';
import { normalizePath } from './pathUtils';

/**
 * Project identity resolver (Plan 301 §Phase B).
 *
 * Resolves a chat session's `working_directory` (and optional explicit
 * override) to a stable `project_id` UUID, registering the project
 * and its path alias on first sight. Subsequent calls with the same
 * normalized path return the same UUID.
 *
 * Resolution order (D3):
 *   1. Override (explicit_workspace_root OR file-based override
 *      matching by longest canonical_root prefix)
 *   2. working_directory — normalized lexically; complete path is the
 *      identity input. We do NOT replace a missing path with an
 *      existing ancestor (D5: monorepo subdirs do NOT auto-merge).
 *   3. cwd fallback — only when working_directory is empty/missing.
 *
 * Git metadata is NEVER used to change project identity (D5). The
 * `gitProbe` hook is supported only for debug metadata and does not
 * affect the resolved `project_id`. The earlier "git root" wording
 * in the resolution order is REMOVED (D3).
 *
 * D6: `agent_profile_id` is provenance only and never affects
 * identity, scope, or visibility.
 */

export interface ResolveProjectInput {
  workingDirectory: string;
  agent_profile_id?: string; // provenance only — never affects identity (D6)
  explicit_workspace_root?: string;
  cwd?: string;
  // Test injection:
  memoryDb?: Database;
  workspaceOverridesPath?: string;
  platform?: 'win32' | 'darwin' | 'linux';
  gitProbe?: (dir: string) => { root: string } | null;
}

export interface ResolveProjectResult {
  project_id: string;
  canonical_root: string;
  resolution_source: 'override' | 'working_directory' | 'cwd';
  alias_kind: 'workspace_override' | 'working_directory' | 'cwd';
  absolute_normalized_path: string;
}

export type AliasKind = 'workspace_override' | 'working_directory' | 'cwd';

const GIT_PROBE_TIMEOUT_MS = 1500;

// Re-export normalizePath so callers (catalogSync) can import everything
// from projectResolver without learning about pathUtils.
export { normalizePath } from './pathUtils';
export type { NormalizedPath } from './pathUtils';

/**
 * Resolve a project for a chat session.
 *
 * See module docstring for the resolution algorithm. The function is
 * idempotent: calling twice with the same `workingDirectory` returns
 * the same `project_id`. The first call registers the project and its
 * alias in the memory DB; subsequent calls find the alias and return.
 *
 * Throws structured errors on irrecoverable failures:
 *   - Override path conflicts with another project's alias
 *   - DB transaction failures
 */
export function resolveProject(input: ResolveProjectInput): ResolveProjectResult {
  const platform = input.platform ?? (process.platform as 'win32' | 'darwin' | 'linux');
  const overrides = loadWorkspaceOverrides({
    configPath: input.workspaceOverridesPath,
  });

  // Step 1: Override path.
  const overrideMatch = matchOverride(input, overrides, platform);
  if (overrideMatch) {
    const { override, matchedPath } = overrideMatch;
    // Register the alias so subsequent lookups hit the fast path.
    // The override's `canonical_root` is the identity anchor.
    const { absolute_normalized_path } = normalizePath(matchedPath, platform);
    registerProject({
      memoryDb: input.memoryDb,
      requestedProjectId: override.project_id,
      canonical_root: override.canonical_root,
      alias_kind: 'workspace_override',
      absolute_normalized_path,
    });
    return {
      project_id: override.project_id,
      canonical_root: override.canonical_root,
      resolution_source: 'override',
      alias_kind: 'workspace_override',
      absolute_normalized_path,
    };
  }

  // Step 2: working_directory.
  //
  // D3: "normalize the original working directory lexically and use
  // that complete path as the project identity input. Do not replace
  // a missing path with an existing ancestor." The lexical path IS
  // the identity — we never walk up the filesystem to find an
  // existing ancestor, because that would merge unrelated sessions
  // (D5: monorepo subdirs do NOT auto-merge). `normalizePath` already
  // falls back to the lexical path when `realpathSync` fails (symlink
  // loop, missing path, etc.), so the identity remains stable across
  // mount/unmount of removable drives.
  const workingDir = input.workingDirectory?.trim() ?? '';
  if (workingDir) {
    const { absolute_normalized_path, canonical_root } = normalizePath(workingDir, platform);

    const { project_id } = registerProject({
      memoryDb: input.memoryDb,
      canonical_root,
      alias_kind: 'working_directory',
      absolute_normalized_path,
    });

    // Optional git probe — never changes identity (D5). The result
    // is debug metadata only and is NOT persisted to
    // `project_path_aliases` because the table's PK on
    // `absolute_normalized_path` would conflict with future
    // identity aliases at the same path. Plan 301's failure modes
    // table says git metadata "may be recorded separately" — we
    // leave that to a future plan if needed.
    if (input.gitProbe) {
      try {
        input.gitProbe(workingDir);
      } catch {
        // best-effort — git probe failures must not break resolution.
      }
    }

    return {
      project_id,
      canonical_root,
      resolution_source: 'working_directory',
      alias_kind: 'working_directory',
      absolute_normalized_path,
    };
  }

  // Step 3: cwd fallback.
  if (input.cwd) {
    const { absolute_normalized_path, canonical_root } = normalizePath(input.cwd, platform);
    const { project_id } = registerProject({
      memoryDb: input.memoryDb,
      canonical_root,
      alias_kind: 'cwd',
      absolute_normalized_path,
    });
    return {
      project_id,
      canonical_root,
      resolution_source: 'cwd',
      alias_kind: 'cwd',
      absolute_normalized_path,
    };
  }

  // No working_directory, no cwd, no override — caller should have
  // handled this before calling resolveProject (catalogSync falls
  // back to global scope). Throw so the bug is visible.
  throw new Error(
    'memory-state: resolveProject called with no working_directory, no cwd, and no override match'
  );
}

/**
 * Match a workspace override to the input.
 *
 * Rules:
 *   - If `explicit_workspace_root` is set, normalize it and look for
 *     an exact match in the overrides list. If found, that override
 *     wins.
 *   - Otherwise, normalize `workingDirectory` and find the override
 *     whose `canonical_root` is a path-segment-prefix match (longest
 *     match wins). `D:/foo` matches `D:/foo/bar` but NOT `D:/foobar`.
 *   - On a tie (two overrides with the same length), the first one
 *     in the file wins (deterministic).
 *
 * Returns `{ override, matchedPath }` where `matchedPath` is the path
 * that should be registered as the alias (the working directory, not
 * the override's canonical_root, so we record that the working
 * directory is an alias of the override's project).
 */
function matchOverride(
  input: ResolveProjectInput,
  overrides: WorkspaceOverride[],
  platform: string
): { override: WorkspaceOverride; matchedPath: string } | null {
  if (overrides.length === 0) return null;

  // Explicit override wins.
  if (input.explicit_workspace_root) {
    const explicitNorm = normalizePath(input.explicit_workspace_root, platform).absolute_normalized_path;
    const exact = overrides.find((o) => o.canonical_root === explicitNorm);
    if (exact) {
      return { override: exact, matchedPath: input.explicit_workspace_root };
    }
  }

  // Longest-prefix match against workingDirectory.
  const workingDir = input.workingDirectory?.trim() ?? '';
  if (!workingDir) return null;
  const workingNorm = normalizePath(workingDir, platform).absolute_normalized_path;

  let best: WorkspaceOverride | null = null;
  let bestLen = -1;
  for (const override of overrides) {
    const root = override.canonical_root;
    if (root === workingNorm) {
      // Exact match — always wins.
      return { override, matchedPath: workingDir };
    }
    // Path-segment prefix: workingNorm must be `root + '/' + ...`.
    if (workingNorm.startsWith(root + '/')) {
      if (root.length > bestLen) {
        best = override;
        bestLen = root.length;
      }
    }
  }
  if (best) {
    return { override: best, matchedPath: workingDir };
  }
  return null;
}

/**
 * Register a project in the memory DB.
 *
 * Algorithm (Plan 301 §Phase B "Project registration"):
 *   1. BEGIN IMMEDIATE
 *   2. SELECT from `project_path_aliases` by `absolute_normalized_path`.
 *      If found → return existing `project_id`.
 *   3. Otherwise SELECT from `projects` by `canonical_root` (UNIQUE
 *      catches duplicates). If found → INSERT alias; return.
 *   4. Otherwise generate UUID v4, INSERT both `projects` row and
 *      `project_path_aliases` row. COMMIT.
 *
 * If `requestedProjectId` is provided (from an override), we use it
 * as the project_id. If it conflicts with an existing alias path that
 * belongs to a different project_id, we throw a structured error.
 */
export function registerProject(input: {
  memoryDb?: Database;
  requestedProjectId?: string;
  canonical_root: string;
  alias_kind: AliasKind;
  absolute_normalized_path: string;
  relative_path?: string | null;
}): { project_id: string; canonical_root: string } {
  const db = input.memoryDb;
  if (!db) {
    throw new Error('memory-state: registerProject requires a memoryDb handle');
  }

  const now = Date.now();

  const txn = db.transaction(() => {
    // Step 2: alias lookup. Exclude `git_root` aliases — git_root is
    // debug metadata only (D5) and must never participate in identity
    // lookup. Without this filter, a session whose working_directory
    // happens to equal another session's git_root would inherit the
    // other project's identity, violating D5.
    const aliasRow = db
      .prepare(
        `SELECT project_id FROM project_path_aliases
         WHERE absolute_normalized_path = ? AND alias_kind != 'git_root'`
      )
      .get(input.absolute_normalized_path) as { project_id: string } | undefined;

    if (aliasRow) {
      // Verify override does not conflict with the existing alias.
      if (input.requestedProjectId && input.requestedProjectId !== aliasRow.project_id) {
        throw new ProjectAliasConflictError(
          input.absolute_normalized_path,
          aliasRow.project_id,
          input.requestedProjectId
        );
      }
      // Bump last_seen_at so we know the alias was recently observed.
      db.prepare(
        'UPDATE project_path_aliases SET last_seen_at = ? WHERE absolute_normalized_path = ?'
      ).run(now, input.absolute_normalized_path);
      db.prepare('UPDATE projects SET last_seen_at = ? WHERE project_id = ?').run(
        now,
        aliasRow.project_id
      );
      return { project_id: aliasRow.project_id, canonical_root: input.canonical_root };
    }

    // Step 3: existing project by canonical_root.
    const projectRow = db
      .prepare('SELECT project_id FROM projects WHERE canonical_root = ?')
      .get(input.canonical_root) as { project_id: string } | undefined;

    if (projectRow) {
      // Override is asking for a specific UUID at a new path that maps
      // to an existing project — if the requested UUID differs, that's
      // a conflict.
      if (input.requestedProjectId && input.requestedProjectId !== projectRow.project_id) {
        throw new ProjectAliasConflictError(
          input.absolute_normalized_path,
          projectRow.project_id,
          input.requestedProjectId
        );
      }
      const projectId = input.requestedProjectId ?? projectRow.project_id;
      insertAlias(db, projectId, input, now);
      return { project_id: projectId, canonical_root: input.canonical_root };
    }

    // Step 4: brand-new project. Use requestedProjectId if provided,
    // else generate UUID v4.
    const projectId = input.requestedProjectId ?? randomUUID();
    db.prepare(
      `INSERT INTO projects (project_id, canonical_root, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`
    ).run(projectId, input.canonical_root, now, now);
    insertAlias(db, projectId, input, now);
    return { project_id: projectId, canonical_root: input.canonical_root };
  });

  return txn.immediate();
}

function insertAlias(
  db: Database,
  projectId: string,
  input: {
    absolute_normalized_path: string;
    alias_kind: AliasKind;
    relative_path?: string | null;
  },
  now: number
): void {
  db.prepare(
    `INSERT INTO project_path_aliases
       (project_id, absolute_normalized_path, relative_path, alias_kind,
        first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    input.absolute_normalized_path,
    input.relative_path ?? null,
    input.alias_kind,
    now,
    now
  );
}

/**
 * Structured error for override/alias conflicts. Thrown when an
 * override asks to pin a path to project_id A, but the path is
 * already registered as an alias of project_id B.
 */
export class ProjectAliasConflictError extends Error {
  constructor(
    public readonly absolute_normalized_path: string,
    public readonly existing_project_id: string,
    public readonly requested_project_id: string
  ) {
    super(
      `memory-state: alias conflict — path "${absolute_normalized_path}" is already ` +
        `registered to project_id "${existing_project_id}", cannot reassign to ` +
        `"${requested_project_id}". Remove the existing alias or use a different path.`
    );
    this.name = 'ProjectAliasConflictError';
  }
}

/**
 * Default git probe implementation. Shells out to
 * `git rev-parse --show-toplevel` with a 1500ms timeout. Returns
 * `{ root }` on success or `null` on any failure (non-zero exit,
 * timeout, ENOENT, etc.).
 *
 * Used by catalogSync when no test injection is provided. The git
 * probe result is debug metadata only — it never changes project
 * identity (D5).
 */
export function defaultGitProbe(dir: string): { root: string } | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeout: GIT_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const root = result.stdout.trim();
    if (!root) return null;
    return { root };
  } catch {
    return null;
  }
}

/**
 * Resolve a project using the default git probe. Convenience wrapper
 * for production callers (catalogSync). Tests should call
 * `resolveProject` directly with a mocked `gitProbe`.
 */
export function resolveProjectWithDefaults(
  input: Omit<ResolveProjectInput, 'gitProbe'> & { gitProbe?: ResolveProjectInput['gitProbe'] }
): ResolveProjectResult {
  return resolveProject({
    ...input,
    gitProbe: input.gitProbe ?? defaultGitProbe,
  });
}
