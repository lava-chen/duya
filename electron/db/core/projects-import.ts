/**
 * projects-import.ts — one-time migration of `projects` / `project_bots`
 * rows from `memory-state.db` into `duya-core.db` (plan 534, task 2.3).
 *
 * The `projects` table was misplaced in `memory-state.db` (plan 525). Reads
 * and entity CRUD now target core (ProjectStore + projectResolver re-routed),
 * but existing historical rows carry user-authored data — `name`,
 * `description`, `icon`, `color`, `paths`, `last_seen_at` — that a lazy
 * re-registration on first touch would lose (it would mint a fresh row with
 * defaults). This import preserves them verbatim.
 *
 * The source DB is opened read-only from its resolved file path (`<bootDir>/
 * memory-state.db`) so the import runs correctly whether or not the memory
 * worker is enabled this session — project rows were written by projectResolver
 * during sessions, independent of the worker.
 *
 * The schema is a verbatim carry-over (identical columns), so a straight
 * `INSERT OR IGNORE` is enough: a conflict on either `project_id` (PK) or
 * `canonical_root` (UNIQUE) skips a row that core already owns, making the
 * migration idempotent and safe to re-run after an interrupted boot.
 *
 * Completion is recorded in core `meta` (`projects_imported_from_memory_state`)
 * so the import only runs once; see `needsProjectsImport`.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { getLogger, LogComponent } from '../../logging/logger';
import type { ProjectBotRow, ProjectRow } from './project-store';

/** Completion marker key in core `meta`. */
export const PROJECTS_IMPORTED_MARKER_KEY = 'projects_imported_from_memory_state';

/** Minimal typed handle over the better-sqlite3 driver (kept duck-typed for tests). */
export interface ImportDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

export interface ProjectsImportOptions {
  /** Absolute path to `memory-state.db` (opened read-only). */
  memoryDbPath: string;
  /** Read/write handle to `duya-core.db` (destination). */
  coreDb: ImportDb;
  /** Optional better-sqlite3 ctor (injected for tests; defaults to `require('better-sqlite3')`). */
  sqlite?: unknown;
}

export interface ProjectsImportReport {
  projects: number;
  bots: number;
  /** True when the source file was absent and nothing was imported. */
  skipped: boolean;
  durationMs: number;
}

/** True when core has not yet recorded the import completion marker. */
export function needsProjectsImport(coreDb: ImportDb): boolean {
  const row = coreDb
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(PROJECTS_IMPORTED_MARKER_KEY) as { value?: string } | undefined;
  return !row;
}

function openMemoryReadonly(path: string, sqlite?: unknown): ImportDb | null {
  if (!fs.existsSync(path)) return null;
  const Ctor = (sqlite ?? createRequire(__filename)('better-sqlite3')) as unknown as {
    new (filename: string, opts: object): ImportDb;
  };
  return new Ctor(path, { readonly: true, fileMustExist: true }) as ImportDb;
}

/**
 * Copy `memory-state.db.projects` / `project_bots` into core. Idempotent via
 * `INSERT OR IGNORE`; skips missing source tables rather than throwing, so a
 * DB that predates migration 0012 imports nothing and can still boot.
 */
export function runProjectsImport(opts: ProjectsImportOptions): ProjectsImportReport {
  const started = Date.now();
  const logger = getLogger();

  const source = openMemoryReadonly(opts.memoryDbPath, opts.sqlite);
  if (!source) {
    return { projects: 0, bots: 0, skipped: true, durationMs: Date.now() - started };
  }
  try {
    const sourceProjects = readTableQuiet<ProjectRow>(source, 'projects');
    const sourceBots = readTableQuiet<ProjectBotRow>(source, 'project_bots');
    const projectsMigrated = insertProjectsQuiet(opts.coreDb, sourceProjects);
    const botsMigrated = insertBotsQuiet(opts.coreDb, sourceBots);

    opts.coreDb
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(PROJECTS_IMPORTED_MARKER_KEY, `v1@${new Date().toISOString()}`);

    if (projectsMigrated > 0 || botsMigrated > 0) {
      logger.info(
        'projects imported from memory-state into core',
        { projects: projectsMigrated, bots: botsMigrated, durationMs: Date.now() - started },
        LogComponent.DB,
      );
    }
    return { projects: projectsMigrated, bots: botsMigrated, skipped: false, durationMs: Date.now() - started };
  } finally {
    source.close();
  }
}

/** Read all rows of a table; missing table → [] (older DB). */
function readTableQuiet<T>(db: ImportDb, table: string): T[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as T[];
  } catch {
    getLogger().warn(
      `projects import: \`${table}\` missing in memory-state — treating as empty`,
      undefined,
      LogComponent.DB,
    );
    return [];
  }
}

/**
 * INSERT OR IGNORE each source project into core. Both `project_id` (PK) and
 * `canonical_root` (UNIQUE) collisions are safely skipped, so rows core
 * already owns (e.g. from a re-registration or a partial prior run) stay put.
 */
function insertProjectsQuiet(coreDb: ImportDb, rows: ProjectRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = coreDb.prepare(
    `INSERT OR IGNORE INTO projects (
      project_id, canonical_root, name, description, paths, icon, color,
      created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.project_id,
      r.canonical_root,
      r.name ?? '',
      r.description ?? null,
      r.paths ?? '[]',
      r.icon ?? null,
      r.color ?? null,
      r.created_at,
      r.last_seen_at,
    );
  }
  return rows.length;
}

function insertBotsQuiet(coreDb: ImportDb, rows: ProjectBotRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = coreDb.prepare(
    `INSERT OR IGNORE INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(r.project_id, r.bot_id, r.joined_at);
  }
  return rows.length;
}