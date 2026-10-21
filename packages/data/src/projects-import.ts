/** One-time import of project metadata from the legacy memory-state database. */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import type { DataLogger } from './core-database.js';
import type { ProjectBotRow, ProjectRow } from './project-store.js';

const require = createRequire(import.meta.url);

/** Completion marker key in core meta. */
export const PROJECTS_IMPORTED_MARKER_KEY = 'projects_imported_from_memory_state';

/** Minimal typed handle over better-sqlite3, kept duck-typed for callers. */
export interface ImportDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

export interface ProjectsImportOptions {
  /** Absolute path to memory-state.db, opened read-only. */
  memoryDbPath: string;
  /** Read/write handle to duya-core.db. */
  coreDb: ImportDb;
  /** Optional better-sqlite3 constructor, primarily for tests. */
  sqlite?: unknown;
  logger?: DataLogger;
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
  const Ctor = (sqlite ?? require('better-sqlite3')) as {
    new (filename: string, opts: object): ImportDb;
  };
  return new Ctor(path, { readonly: true, fileMustExist: true });
}

/** Copy projects and project_bots rows into core; safe to retry after interruption. */
export function runProjectsImport(opts: ProjectsImportOptions): ProjectsImportReport {
  const started = Date.now();
  const source = openMemoryReadonly(opts.memoryDbPath, opts.sqlite);
  if (!source) {
    return { projects: 0, bots: 0, skipped: true, durationMs: Date.now() - started };
  }

  try {
    const sourceProjects = readTableQuiet<ProjectRow>(source, 'projects', opts.logger);
    const sourceBots = readTableQuiet<ProjectBotRow>(source, 'project_bots', opts.logger);
    const projectsMigrated = insertProjectsQuiet(opts.coreDb, sourceProjects);
    const botsMigrated = insertBotsQuiet(opts.coreDb, sourceBots);

    opts.coreDb
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(PROJECTS_IMPORTED_MARKER_KEY, 'v1@' + new Date().toISOString());

    if (projectsMigrated > 0 || botsMigrated > 0) {
      opts.logger?.({
        level: 'info',
        category: 'database',
        message: 'Projects imported from memory-state into core',
        data: { projects: projectsMigrated, bots: botsMigrated, durationMs: Date.now() - started },
      });
    }
    return {
      projects: projectsMigrated,
      bots: botsMigrated,
      skipped: false,
      durationMs: Date.now() - started,
    };
  } finally {
    source.close();
  }
}

/** Read all rows of a table; a missing table means an older source DB. */
function readTableQuiet<T>(db: ImportDb, table: string, logger?: DataLogger): T[] {
  try {
    return db.prepare('SELECT * FROM ' + table).all() as T[];
  } catch (error) {
    logger?.({
      level: 'warn',
      category: 'database',
      message: 'Projects import skipped missing or unreadable table: ' + table,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return [];
  }
}

function insertProjectsQuiet(coreDb: ImportDb, rows: ProjectRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = coreDb.prepare(
    'INSERT OR IGNORE INTO projects (' +
      'project_id, canonical_root, name, description, paths, icon, color, created_at, last_seen_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    stmt.run(
      row.project_id,
      row.canonical_root,
      row.name ?? '',
      row.description ?? null,
      row.paths ?? '[]',
      row.icon ?? null,
      row.color ?? null,
      row.created_at,
      row.last_seen_at,
    );
  }
  return rows.length;
}

function insertBotsQuiet(coreDb: ImportDb, rows: ProjectBotRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = coreDb.prepare(
    'INSERT OR IGNORE INTO project_bots (project_id, bot_id, joined_at) VALUES (?, ?, ?)',
  );
  for (const row of rows) stmt.run(row.project_id, row.bot_id, row.joined_at);
  return rows.length;
}
