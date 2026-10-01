/**
 * workbench-store.ts — Persistence for canvas data sources and handler code
 * (plan 570). Module-owned side tables on the legacy main database, following
 * the `toolApprovalState.ts` pattern: idempotent `prepare().run()` DDL safe to
 * run on every boot, one statement per prepare.
 *
 * The conductor subsystem (canvases/elements/actions) lives on the main
 * database — see `apps/desktop/src/main/db/queries/conductors.ts` — so the workbench tables
 * colocate there and join against `conductor_canvases`.
 */

import { randomUUID } from 'crypto';
import type { DataSourceRow, WorkbenchSourceConfig, WorkbenchSourceType } from './workbench-types';

interface DataSourceDbRow {
  id: string;
  canvas_id: string;
  name: string;
  type: string;
  config: string;
  refresh_interval_sec: number;
  last_snapshot: string | null;
  last_refreshed_at: number | null;
  last_error: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function safeParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sourceFromDb(row: DataSourceDbRow): DataSourceRow {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    name: row.name,
    type: row.type as WorkbenchSourceType,
    config: (safeParse(row.config) ?? {}) as WorkbenchSourceConfig,
    refreshIntervalSec: row.refresh_interval_sec,
    lastSnapshot: safeParse(row.last_snapshot),
    lastRefreshedAt: row.last_refreshed_at,
    lastError: row.last_error,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureWorkbenchTables(db: import('better-sqlite3').Database): void {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS conductor_data_sources (' +
      'id TEXT PRIMARY KEY, ' +
      'canvas_id TEXT NOT NULL, ' +
      'name TEXT NOT NULL, ' +
      "type TEXT NOT NULL CHECK (type IN ('http', 'project_db', 'computed')), " +
      "config TEXT NOT NULL DEFAULT '{}', " +
      'refresh_interval_sec INTEGER NOT NULL DEFAULT 0, ' +
      'last_snapshot TEXT, ' +
      'last_refreshed_at INTEGER, ' +
      'last_error TEXT, ' +
      'enabled INTEGER NOT NULL DEFAULT 1, ' +
      'created_at INTEGER NOT NULL, ' +
      'updated_at INTEGER NOT NULL, ' +
      'FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE)',
  ).run();
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_canvas_name ON conductor_data_sources(canvas_id, name)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_data_sources_due ON conductor_data_sources(enabled, refresh_interval_sec)',
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS conductor_handlers (' +
      'id TEXT PRIMARY KEY, ' +
      'canvas_id TEXT NOT NULL, ' +
      'name TEXT NOT NULL, ' +
      'description TEXT, ' +
      'code TEXT NOT NULL, ' +
      'enabled INTEGER NOT NULL DEFAULT 1, ' +
      'created_at INTEGER NOT NULL, ' +
      'updated_at INTEGER NOT NULL, ' +
      'FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE)',
  ).run();
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_handlers_canvas_name ON conductor_handlers(canvas_id, name)',
  ).run();
}

// ============================================================
// Data sources
// ============================================================

export interface CreateDataSourceInput {
  canvasId: string;
  name: string;
  type: WorkbenchSourceType;
  config: WorkbenchSourceConfig;
  refreshIntervalSec?: number;
  enabled?: boolean;
}

export function createDataSource(db: import('better-sqlite3').Database, input: CreateDataSourceInput): DataSourceRow {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO conductor_data_sources ' +
      '(id, canvas_id, name, type, config, refresh_interval_sec, last_snapshot, last_refreshed_at, last_error, enabled, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
  ).run(
    id,
    input.canvasId,
    input.name,
    input.type,
    JSON.stringify(input.config ?? {}),
    Math.max(0, Math.floor(input.refreshIntervalSec ?? 0)),
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getDataSource(db, id) as DataSourceRow;
}

export interface UpdateDataSourceInput {
  name?: string;
  config?: WorkbenchSourceConfig;
  refreshIntervalSec?: number;
  enabled?: boolean;
}

export function updateDataSource(
  db: import('better-sqlite3').Database,
  id: string,
  patch: UpdateDataSourceInput,
): DataSourceRow | null {
  const existing = getDataSource(db, id);
  if (!existing) return null;
  const next = {
    name: patch.name ?? existing.name,
    config: patch.config ?? existing.config,
    refreshIntervalSec:
      patch.refreshIntervalSec !== undefined
        ? Math.max(0, Math.floor(patch.refreshIntervalSec))
        : existing.refreshIntervalSec,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
  };
  db.prepare(
    'UPDATE conductor_data_sources SET name = ?, config = ?, refresh_interval_sec = ?, enabled = ?, updated_at = ? WHERE id = ?',
  ).run(next.name, JSON.stringify(next.config), next.refreshIntervalSec, next.enabled, Date.now(), id);
  return getDataSource(db, id);
}

export function deleteDataSource(db: import('better-sqlite3').Database, id: string): boolean {
  const result = db.prepare('DELETE FROM conductor_data_sources WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getDataSource(db: import('better-sqlite3').Database, id: string): DataSourceRow | null {
  const row = db.prepare('SELECT * FROM conductor_data_sources WHERE id = ?').get(id) as
    | DataSourceDbRow
    | undefined;
  return row ? sourceFromDb(row) : null;
}

export function listDataSourcesByCanvas(db: import('better-sqlite3').Database, canvasId: string): DataSourceRow[] {
  return (
    db
      .prepare('SELECT * FROM conductor_data_sources WHERE canvas_id = ? ORDER BY created_at ASC')
      .all(canvasId) as DataSourceDbRow[]
  ).map(sourceFromDb);
}

/** Persist a refresh outcome. Snapshot must already be JSON-serializable. */
export function saveDataSourceRefresh(
  db: import('better-sqlite3').Database,
  id: string,
  outcome: { snapshot?: unknown; error?: string | null },
): void {
  const snapshotJson =
    outcome.snapshot === undefined ? undefined : outcome.snapshot === null ? null : JSON.stringify(outcome.snapshot);
  if (snapshotJson === undefined) {
    db.prepare('UPDATE conductor_data_sources SET last_error = ?, last_refreshed_at = last_refreshed_at, updated_at = ? WHERE id = ?').run(
      outcome.error ?? null,
      Date.now(),
      id,
    );
    return;
  }
  db.prepare(
    'UPDATE conductor_data_sources SET last_snapshot = ?, last_error = ?, last_refreshed_at = ?, updated_at = ? WHERE id = ?',
  ).run(snapshotJson, outcome.error ?? null, Date.now(), Date.now(), id);
}

// NOTE (plan 570 v1): conductor_handlers CRUD lands together with
// server-side handler execution. The table is created in
// ensureWorkbenchTables as a forward-looking schema commitment.
