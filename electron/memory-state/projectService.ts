import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from './db';
import { parseProjectPaths, serializeProjectPaths, type ProjectPathEntry, type ProjectRow } from './schema';
import { normalizePath } from './pathUtils';
import { getLogger, LogComponent } from '../logging/logger';

/**
 * Project entity service (Plan 525 Phase 3).
 *
 * Owns the global plans directory layout:
 *
 *   ~/.duya/projects/<project_id>/
 *     plans/
 *       index.json          — plan index for this project
 *       active/<NNN>-slug.md
 *       completed/<NNN>-slug.md
 *
 * The directory is created when a project is created and is bound to
 * the stable UUID — plans live globally, not per workspace. Users
 * manage projects manually (no UI, no manage_project tool per Plan
 * 525 §1.3); this service is the programmatic entry point.
 *
 * The `projectsRoot` option exists for tests; production resolves
 * `~/.duya/projects` (DUYA_TEST-namespace aware, same semantics as
 * tier-rpc's duya root).
 */

export type PlanStatus = 'active' | 'paused' | 'done' | 'blocked';

/** One plan entry inside a project's plans/index.json (Plan 525 §3.4). */
export interface PlansIndexEntry {
  id: number;
  slug: string;
  title: string;
  status: PlanStatus;
  priority?: string;
  tags?: string[];
  /** Relative to the plans dir, e.g. `active/525-project-entity.md`. */
  file: string;
  /** YYYY-MM-DD. */
  created: string;
  /** YYYY-MM-DD. */
  updated: string;
}

export interface PlansIndex {
  projectId: string;
  plans: PlansIndexEntry[];
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  /**
   * Path entries for the project; `paths[0].path` implicitly derives
   * `canonical_root` (Plan 525 §7). At least one path is required.
   */
  paths: Array<{ path: string; description?: string | null }>;
  /** Avatar icon name (migration 0013). NULL/undefined = default folder icon. */
  icon?: string | null;
  /** Avatar accent color keyword (migration 0013). NULL/undefined = default. */
  color?: string | null;
}

export interface ProjectServiceOptions {
  /** Test injection: memory DB handle. Defaults to the bootstrapped singleton. */
  memoryDb?: Database;
  /** Test injection: overrides `~/.duya/projects` (or its test-namespace root). */
  projectsRoot?: string;
}

/** Resolve `~/.duya/projects` (test-namespace aware). */
export function resolveProjectsRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns, 'projects');
  }
  return path.join(base, 'projects');
}

function projectsBase(opts?: ProjectServiceOptions): string {
  return opts?.projectsRoot ?? resolveProjectsRoot();
}

export function projectPlansDir(projectId: string, opts?: ProjectServiceOptions): string {
  return path.join(projectsBase(opts), projectId, 'plans');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Create the plans directory skeleton for a project:
 * `plans/`, `plans/active/`, `plans/completed/`. Idempotent.
 */
export function ensurePlansDirs(
  projectId: string,
  opts?: ProjectServiceOptions
): { plansDir: string; activeDir: string; completedDir: string } {
  const plansDir = projectPlansDir(projectId, opts);
  const activeDir = path.join(plansDir, 'active');
  const completedDir = path.join(plansDir, 'completed');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(completedDir, { recursive: true });
  return { plansDir, activeDir, completedDir };
}

/**
 * Write a project's plans/index.json. Overwrites the file atomically
 * enough for a single-writer (main process) workload: write to a temp
 * sibling then rename.
 */
export function writePlansIndex(
  projectId: string,
  plans: PlansIndexEntry[],
  opts?: ProjectServiceOptions
): PlansIndex {
  ensurePlansDirs(projectId, opts);
  const index: PlansIndex = { projectId, plans };
  const indexPath = path.join(projectPlansDir(projectId, opts), 'index.json');
  const tmpPath = `${indexPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmpPath, indexPath);
  return index;
}

/**
 * Read a project's plans/index.json. A missing or corrupted file
 * degrades to an empty index — never throws (same philosophy as
 * `parseProjectPaths`).
 */
export function readPlansIndex(projectId: string, opts?: ProjectServiceOptions): PlansIndex {
  const indexPath = path.join(projectPlansDir(projectId, opts), 'index.json');
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return { projectId, plans: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PlansIndex>;
    if (!Array.isArray(parsed.plans)) return { projectId, plans: [] };
    return { projectId, plans: parsed.plans as PlansIndexEntry[] };
  } catch {
    return { projectId, plans: [] };
  }
}

/**
 * Normalize every path entry of an input path list. Empty or invalid
 * paths are dropped (caller already enforced ≥1 entry). Returns the
 * deduped list keyed by `absolute_normalized_path`.
 *
 * Defense-in-depth for L1 (Plan 525 hardening):
 * - `path.resolve` collapses `..`/`.` and makes the path absolute.
 * - `realpathSync.native` resolves symlinks (falls back to lexical on
 *   failure so we never throw on missing drives).
 * - `path.posix.normalize` collapses duplicate separators.
 * - Win32 only: drive letter is lowercased so case mismatch on
 *   `E:\Foo` vs `e:/foo` does not produce two distinct projects.
 *
 * Every consumer of `projects.paths` (db-bridge, projectResolver,
 * plan MCP) can now assume entries are already normalized — they only
 * need to normalize the *query* side. This removes the L3 algorithm
 * fork where db-bridge used a different `normalizeForMatch` than
 * `pathUtils.normalizePath`.
 */
export function normalizeProjectPathEntries(
  paths: Array<{ path: string; description?: string | null }>,
  opts?: { platform?: string; logger?: ReturnType<typeof getLogger> },
): ProjectPathEntry[] {
  const platform = opts?.platform ?? process.platform;
  const logger = opts?.logger ?? getLogger();
  const seen = new Set<string>();
  const out: ProjectPathEntry[] = [];
  for (const entry of paths) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('project-service: path entries must have a non-empty `path`');
    }
    if (entry.path.length > MAX_PROJECT_PATH_LENGTH) {
      throw new Error(
        `project-service: path entries must be ≤ ${MAX_PROJECT_PATH_LENGTH} characters`,
      );
    }
    // Defense against renderer-supplied NUL / control bytes and UNC
    // symlink escapes. NUL is rejected by `path.resolve` on Node but
    // we surface a clean error early. Backslashes and forward slashes
    // are both legal; we only reject the things that *cannot* be
    // safely normalized to a single canonical form.
    if (entry.path.includes('\0')) {
      throw new Error('project-service: path entries must not contain NUL bytes');
    }
    let normalized: string;
    try {
      normalized = normalizePath(entry.path, platform).absolute_normalized_path;
    } catch (err) {
      logger.warn(
        'project-service: path normalization failed, skipping entry',
        { raw: entry.path, error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ path: normalized, description: entry.description ?? null });
  }
  if (out.length === 0) {
    throw new Error(
      'project-service: at least one valid path entry is required (all entries failed normalization)',
    );
  }
  return out;
}

/** Cap on a single path entry to bound JSON column size. 4096 chars is
 *  generous for any realistic Windows / POSIX path and rejects
 *  pathological input that would inflate `projects.paths` JSON. */
export const MAX_PROJECT_PATH_LENGTH = 4096;

/**
 * Create a project row and its plans directory skeleton.
 *
 * `canonical_root` is derived from `paths[0].path` (Plan 525 §7);
 * at least one path is required. Not idempotent — each call mints a
 * new UUID, so duplicate calls produce distinct projects. The
 * renderer's CreateProjectDialog is the production caller (via the
 * `projects:register` IPC handler).
 *
 * All path entries are normalized via `normalizeProjectPathEntries`
 * before insertion so DB state is canonical from day one (L1/L3 fix).
 */
export function createProject(input: CreateProjectInput, opts?: ProjectServiceOptions): ProjectRow {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('project-service: at least one path entry is required (canonical_root derives from paths[0])');
  }
  const entries = normalizeProjectPathEntries(input.paths);
  const canonicalRoot = entries[0].path;

  const db = opts?.memoryDb ?? getDb();
  const now = Date.now();
  const projectId = randomUUID();

  db.prepare(
    `INSERT INTO projects (project_id, canonical_root, name, description, paths, icon, color, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    canonicalRoot,
    input.name,
    input.description ?? null,
    serializeProjectPaths(entries),
    input.icon ?? null,
    input.color ?? null,
    now,
    now
  );

  ensurePlansDirs(projectId, opts);
  writePlansIndex(projectId, [], opts);

  const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow;
  return row;
}

/**
 * List all project rows (raw). Helper for manual management / dogfood.
 */
export function listProjects(opts?: { memoryDb?: Database }): ProjectRow[] {
  const db = opts?.memoryDb ?? getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
  return rows;
}

/**
 * Fetch a single project row by id. Returns null when not found
 * (vs throwing) so callers can decide whether missing is an error.
 *
 * Added in Plan 525 Phase 2.5 (2026-09-13) to support the renderer
 * IPC layer; pure function, no side effects.
 */
export function getProject(projectId: string, opts?: { memoryDb?: Database }): ProjectRow | null {
  if (!projectId || typeof projectId !== 'string') return null;
  const db = opts?.memoryDb ?? getDb();
  const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined;
  return row ?? null;
}

/** Convenience: parsed path entries of a project row. */
export function projectPaths(row: ProjectRow): ProjectPathEntry[] {
  return parseProjectPaths(row.paths);
}

/** Patch shape for `updateProject` — every field optional, NULL clears. */
export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  /** Replacement path list; paths[0].path becomes the new canonical_root. */
  paths?: Array<{ path: string; description?: string | null }>;
  icon?: string | null;
  color?: string | null;
}

/**
 * Patch a project row (ProjectsView "编辑项目"). When `paths` is
 * replaced, canonical_root is re-derived from paths[0].path. Returns
 * the updated row, or null when the project does not exist.
 */
export function updateProject(
  projectId: string,
  patch: UpdateProjectInput,
  opts?: { memoryDb?: Database }
): ProjectRow | null {
  if (!projectId || typeof projectId !== 'string') return null;
  const db = opts?.memoryDb ?? getDb();

  const txn = db.transaction((): ProjectRow | null => {
    const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | ProjectRow
      | undefined;
    if (!row) return null;

    if (typeof patch.name === 'string') {
      db.prepare('UPDATE projects SET name = ? WHERE project_id = ?').run(patch.name, projectId);
    }
    if (patch.description !== undefined) {
      db.prepare('UPDATE projects SET description = ? WHERE project_id = ?').run(
        patch.description,
        projectId
      );
    }
    if (Array.isArray(patch.paths) && patch.paths.length > 0) {
      // Same normalization as createProject so DB state stays canonical.
      // Empty-after-normalize (all entries dropped) is rejected: the
      // caller already gated on length > 0 raw, but normalization can
      // dedupe every entry to nothing — fail loud instead of silently
      // emptying an existing project's paths.
      const entries = normalizeProjectPathEntries(patch.paths);
      db.prepare('UPDATE projects SET paths = ?, canonical_root = ? WHERE project_id = ?').run(
        serializeProjectPaths(entries),
        entries[0].path,
        projectId
      );
    }
    if (patch.icon !== undefined) {
      db.prepare('UPDATE projects SET icon = ? WHERE project_id = ?').run(patch.icon, projectId);
    }
    if (patch.color !== undefined) {
      db.prepare('UPDATE projects SET color = ? WHERE project_id = ?').run(patch.color, projectId);
    }
    return (db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow) ?? null;
  });
  return txn.immediate();
}

/**
 * Delete a project row (ProjectsView "移除项目"). Sessions, threads and
 * rollout files are NOT touched. `rollout_catalog` rows referencing the
 * project are unbound (scope_kind → 'global', project_id → NULL) inside
 * the same transaction — the table's FK is ON DELETE RESTRICT, so the
 * delete would otherwise fail for any project with sessions. Returns
 * true when a row was deleted.
 */
export function deleteProject(projectId: string, opts?: { memoryDb?: Database }): boolean {
  if (!projectId || typeof projectId !== 'string') return false;
  const db = opts?.memoryDb ?? getDb();
  const txn = db.transaction((): boolean => {
    db.prepare(
      `UPDATE rollout_catalog
       SET project_id = NULL, scope_kind = 'global'
       WHERE project_id = ?`
    ).run(projectId);
    db.prepare('DELETE FROM project_bots WHERE project_id = ?').run(projectId);
    const result = db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
    return Number(result.changes) > 0;
  });
  return txn.immediate();
}
