import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from './db';
import { parseProjectPaths, serializeProjectPaths, type ProjectPathEntry, type ProjectRow } from './schema';

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
 * Create a project row and its plans directory skeleton.
 *
 * `canonical_root` is derived from `paths[0].path` (Plan 525 §7);
 * at least one path is required. Not idempotent — each call mints a
 * new UUID, so duplicate calls produce distinct projects (users merge
 * or clean up manually; there is no UI by design).
 */
export function createProject(input: CreateProjectInput, opts?: ProjectServiceOptions): ProjectRow {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('project-service: at least one path entry is required (canonical_root derives from paths[0])');
  }
  const entries: ProjectPathEntry[] = input.paths.map((p) => ({
    path: p.path,
    description: p.description ?? null,
  }));
  const canonicalRoot = entries[0].path;

  const db = opts?.memoryDb ?? getDb();
  const now = Date.now();
  const projectId = randomUUID();

  db.prepare(
    `INSERT INTO projects (project_id, canonical_root, name, description, paths, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    canonicalRoot,
    input.name,
    input.description ?? null,
    serializeProjectPaths(entries),
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
