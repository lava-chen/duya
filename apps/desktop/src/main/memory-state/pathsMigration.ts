import type { ProjectPathEntry } from './schema';

/**
 * One-off data migration: `project_path_aliases` rows → `projects.paths`
 * JSON column (Plan 525 Phase 2).
 *
 * Kept self-contained (no runtime imports) so the CLI script
 * `scripts/migrate-projects-paths.ts` can run under Node's native
 * TypeScript stripping (`node scripts/...ts`), which requires the
 * whole import chain to resolve with explicit extensions and no
 * bundler. The local `parsePathsJson` mirrors
 * `schema.parseProjectPaths` for that reason.
 *
 * Works with both better-sqlite3 and `node:sqlite` through the
 * structural `MinimalDb` interface.
 */

export interface MinimalStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}

export interface MinimalDb {
  prepare(sql: string): MinimalStatement;
  /** Property-signature form: satisfies better-sqlite3 and node:sqlite structurally. */
  exec: (sql: string) => void;
}

/** Shape of a legacy `project_path_aliases` row. */
export interface LegacyAliasRow {
  project_id: string;
  absolute_normalized_path: string;
  relative_path: string | null;
  alias_kind: string;
  /**
   * Real alias rows have no description column; the field exists so
   * tests (and future sources) can exercise first-non-empty merging.
   */
  description?: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ProjectReport {
  project_id: string;
  canonical_root: string | null;
  project_row_exists: boolean;
  alias_row_count: number;
  merged_path_count: number;
  /** Entries already present in projects.paths before the migration. */
  existing_path_count: number;
}

export interface DryRunReport {
  alias_table_exists: boolean;
  total_alias_rows: number;
  total_merged_paths: number;
  orphan_project_ids: string[];
  orphan_alias_rows: number;
  projects: ProjectReport[];
}

/**
 * Parse a projects.paths JSON payload, degrading to [] on any
 * malformed input (mirrors schema.parseProjectPaths).
 */
function parsePathsJson(raw: unknown): ProjectPathEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ProjectPathEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, description } = item as Record<string, unknown>;
    if (typeof path !== 'string' || path === '') continue;
    entries.push({
      path,
      description: typeof description === 'string' && description !== '' ? description : null,
    });
  }
  return entries;
}

/**
 * Group legacy alias rows by project and merge them into
 * `projects.paths` entries (Plan 525 §2.2):
 *
 *   - Multiple alias_kind rows for the same (project_id, path)
 *     collapse into ONE entry — kinds are dropped, all paths equal.
 *   - description = first non-empty among the merged rows (real
 *     migrated rows have none, so entries land as NULL).
 *   - Row order is preserved (deterministic by SELECT ORDER BY).
 */
export function buildPathsByProject(rows: LegacyAliasRow[]): Map<string, ProjectPathEntry[]> {
  const byProject = new Map<string, ProjectPathEntry[]>();
  for (const row of rows) {
    let entries = byProject.get(row.project_id);
    if (!entries) {
      entries = [];
      byProject.set(row.project_id, entries);
    }
    const existing = entries.find((e) => e.path === row.absolute_normalized_path);
    if (existing) {
      if (
        existing.description === null &&
        typeof row.description === 'string' &&
        row.description !== ''
      ) {
        existing.description = row.description;
      }
      continue;
    }
    entries.push({
      path: row.absolute_normalized_path,
      description:
        typeof row.description === 'string' && row.description !== '' ? row.description : null,
    });
  }
  return byProject;
}

function aliasTableExists(db: MinimalDb): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_path_aliases'")
    .get();
  return row !== undefined;
}

interface ProjectDbRow {
  project_id: string;
  canonical_root: string | null;
  paths: string;
}

function readProjects(db: MinimalDb): ProjectDbRow[] {
  return db.prepare('SELECT project_id, canonical_root, paths FROM projects').all() as ProjectDbRow[];
}

function readAliasRows(db: MinimalDb): LegacyAliasRow[] {
  return db
    .prepare(
      `SELECT project_id, absolute_normalized_path, relative_path, alias_kind,
              first_seen_at, last_seen_at
       FROM project_path_aliases
       ORDER BY project_id, absolute_normalized_path`
    )
    .all() as LegacyAliasRow[];
}

/**
 * Compute the dry-run report: what `applyPathsMigration` would change,
 * without writing anything.
 */
export function dryRunPathsMigration(db: MinimalDb): DryRunReport {
  if (!aliasTableExists(db)) {
    return {
      alias_table_exists: false,
      total_alias_rows: 0,
      total_merged_paths: 0,
      orphan_project_ids: [],
      orphan_alias_rows: 0,
      projects: [],
    };
  }

  const aliasRows = readAliasRows(db);
  const projects = readProjects(db);
  const byProject = buildPathsByProject(aliasRows);
  const projectIds = new Set(projects.map((p) => p.project_id));

  const reports: ProjectReport[] = [];
  const seenProjectIds = new Set<string>();
  for (const project of projects) {
    const merged = byProject.get(project.project_id);
    if (merged) seenProjectIds.add(project.project_id);
    reports.push({
      project_id: project.project_id,
      canonical_root: project.canonical_root,
      project_row_exists: true,
      alias_row_count: merged ? countAliasRows(aliasRows, project.project_id) : 0,
      merged_path_count: merged?.length ?? 0,
      existing_path_count: parsePathsJson(project.paths).length,
    });
  }
  // Alias rows pointing at a project_id with no projects row.
  for (const [projectId, entries] of byProject) {
    if (seenProjectIds.has(projectId) || projectIds.has(projectId)) continue;
    reports.push({
      project_id: projectId,
      canonical_root: null,
      project_row_exists: false,
      alias_row_count: countAliasRows(aliasRows, projectId),
      merged_path_count: entries.length,
      existing_path_count: 0,
    });
  }

  const orphanAliasRows = aliasRows.filter((r) => !projectIds.has(r.project_id));
  return {
    alias_table_exists: true,
    total_alias_rows: aliasRows.length,
    total_merged_paths: [...byProject.values()].reduce((n, e) => n + e.length, 0),
    orphan_project_ids: [...new Set(orphanAliasRows.map((r) => r.project_id))],
    orphan_alias_rows: orphanAliasRows.length,
    projects: reports,
  };
}

function countAliasRows(rows: LegacyAliasRow[], projectId: string): number {
  return rows.filter((r) => r.project_id === projectId).length;
}

export interface ApplyResult {
  updated_projects: number;
  dropped_table: boolean;
}

/**
 * Apply the migration in one transaction:
 *
 *   1. Merge alias rows into each project's `paths` JSON (union with
 *      any entries already present — existing entries win on path
 *      collisions since they may carry user descriptions).
 *   2. Verify every alias path survived into exactly one project's
 *      JSON, and every written JSON parses back.
 *   3. Drop `project_path_aliases`.
 *
 * Throws (and rolls back) if the alias table is already gone or if
 * orphan alias rows exist — the caller must resolve those manually
 * rather than have the migration silently drop provenance.
 */
export function applyPathsMigration(db: MinimalDb): ApplyResult {
  if (!aliasTableExists(db)) {
    throw new Error('paths-migration: project_path_aliases table not found — already migrated?');
  }

  const report = dryRunPathsMigration(db);
  if (report.orphan_project_ids.length > 0) {
    throw new Error(
      `paths-migration: ${report.orphan_alias_rows} alias row(s) reference missing projects: ` +
        `${report.orphan_project_ids.join(', ')}. Fix or delete those rows before applying.`
    );
  }

  const aliasRows = readAliasRows(db);
  const byProject = buildPathsByProject(aliasRows);
  const projects = readProjects(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    let updated = 0;
    for (const project of projects) {
      const merged = byProject.get(project.project_id);
      if (!merged || merged.length === 0) continue;
      const existingEntries = parsePathsJson(project.paths);
      const byPath = new Map<string, ProjectPathEntry>();
      for (const entry of existingEntries) byPath.set(entry.path, entry);
      for (const entry of merged) {
        if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
      }
      const json = JSON.stringify([...byPath.values()]);
      // Guard: the payload we are about to persist must parse back.
      if (parsePathsJson(json).length !== byPath.size) {
        throw new Error(`paths-migration: JSON round-trip failed for project ${project.project_id}`);
      }
      db.prepare('UPDATE projects SET paths = ? WHERE project_id = ?').run(json, project.project_id);
      updated++;
    }

    // Loss check: every alias path must appear in exactly one project.
    const covered = new Map<string, number>();
    for (const project of readProjects(db)) {
      for (const entry of parsePathsJson(project.paths)) {
        covered.set(entry.path, (covered.get(entry.path) ?? 0) + 1);
      }
    }
    for (const row of aliasRows) {
      const count = covered.get(row.absolute_normalized_path) ?? 0;
      if (count !== 1) {
        throw new Error(
          `paths-migration: alias path "${row.absolute_normalized_path}" is covered ${count} ` +
            `time(s) after merge (expected exactly 1) — aborting`
        );
      }
    }

    db.exec('DROP TABLE project_path_aliases');
    db.exec('COMMIT');
    return { updated_projects: updated, dropped_table: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Connection already unwound — nothing to roll back.
    }
    throw err;
  }
}
