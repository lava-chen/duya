/**
 * queries/conductors.ts - Conductor (canvas) SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * Operates on conductor_canvases, conductor_widgets, conductor_elements,
 * and conductor_actions tables.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from '../connection';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

function db(): BetterSqlite3 {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return d;
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ============================================================
// Types
// ============================================================

export interface ConductorCanvas {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Project path bound to this canvas (unique per project). Null for ad-hoc canvases. */
  projectPath: string | null;
}

export interface ConductorWidget {
  id: string;
  canvasId: string;
  kind: string;
  type: string;
  position: Record<string, unknown>;
  config: Record<string, unknown>;
  data: Record<string, unknown>;
  dataVersion: number;
  sourceCode: string | null;
  state: string;
  permissions: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ConductorElement {
  id: string;
  canvasId: string;
  elementKind: string;
  position: Record<string, unknown>;
  config: Record<string, unknown>;
  vizSpec: Record<string, unknown> | null;
  sourceCode: string | null;
  state: string;
  dataVersion: number;
  permissions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ConductorAction {
  id: number;
  canvasId: string;
  widgetId: string | null;
  actor: string;
  actionType: string;
  payload: string | null;
  resultPatch: string | null;
  mergedFrom: string | null;
  reversible: number;
  undoneAt: number | null;
  ts: number;
}

export interface ConductorSnapshot {
  canvas: ConductorCanvas;
  elements: ConductorElement[];
  widgets: ConductorWidget[];
  actionCursor: number;
}

export interface WriteActionLogParams {
  canvasId: string;
  widgetId: string | null;
  actor: string;
  actionType: string;
  payload: Record<string, unknown> | null;
  resultPatch: Record<string, unknown> | null;
  reversible?: number;
  mergedFrom?: string | null;
}

// ============================================================
// Canvas CRUD
// ============================================================

/**
 * Map a raw conductor_canvases row to the ConductorCanvas DTO.
 * Shared by listCanvases and listCanvasesForProject so the two list
 * paths always agree on field naming and JSON parsing.
 */
function mapCanvasRow(row: any): ConductorCanvas {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    layoutConfig: safeParseJson<Record<string, unknown>>(row.layout_config, {}),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectPath: row.project_path ?? null,
  };
}

export function listCanvases(): ConductorCanvas[] {
  const rows = db().prepare(
    'SELECT * FROM conductor_canvases ORDER BY sort_order, created_at DESC'
  ).all() as any[];
  return rows.map(mapCanvasRow);
}

/**
 * List canvases scoped to a project path. Includes:
 *   - canvases whose project_path matches the session's working directory
 *   - legacy/shared canvases with project_path IS NULL (created before
 *     project_path was tracked, or intentionally shared)
 * Returns all canvases (unfiltered) when projectPath is null/empty so
 * callers without a session-scoped working directory still see every
 * canvas.
 */
export function listCanvasesForProject(projectPath: string | null): ConductorCanvas[] {
  if (!projectPath) return listCanvases();
  const rows = db().prepare(
    'SELECT * FROM conductor_canvases WHERE project_path = ? OR project_path IS NULL ORDER BY sort_order, created_at DESC'
  ).all(projectPath) as any[];
  return rows.map(mapCanvasRow);
}

/**
 * Find the canvas bound to a given project path. Each project maps to
 * at most one canvas (enforced by idx_conductor_canvases_project_path).
 * Returns null when no canvas has been bound for the project yet.
 */
export function getCanvasByProjectPath(projectPath: string): ConductorCanvas | null {
  const row = db().prepare(
    'SELECT * FROM conductor_canvases WHERE project_path = ?'
  ).get(projectPath) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    layoutConfig: JSON.parse(row.layout_config),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectPath: row.project_path ?? null,
  };
}

export function createCanvas(data: { name: string; description?: string; projectPath?: string | null }): ConductorCanvas {
  const projectPath = data.projectPath ?? null;

  // Project-bound canvases are unique per project path. If one already
  // exists, return it instead of failing on the UNIQUE constraint.
  if (projectPath) {
    const existing = getCanvasByProjectPath(projectPath);
    if (existing) return existing;
  }

  const id = randomUUID();
  const now = Date.now();
  db().prepare(
    'INSERT INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at, project_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, data.name, data.description ?? null, '{}', 0, now, now, projectPath);

  // Return constructed ConductorCanvas directly instead of re-querying
  return {
    id,
    name: data.name,
    description: data.description ?? null,
    layoutConfig: {},
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    projectPath,
  };
}

export function updateCanvas(id: string, data: {
  name?: string;
  description?: string | null;
  layoutConfig?: Record<string, unknown>;
  sortOrder?: number;
}): ConductorCanvas {
  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.layoutConfig !== undefined) { fields.push('layout_config = ?'); values.push(JSON.stringify(data.layoutConfig)); }
  if (data.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(data.sortOrder); }

  // Fetch existing row first to get values for fields not being updated
  const existingRow = db().prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as any;
  if (!existingRow) {
    throw new Error(`Canvas not found: ${id}`);
  }

  values.push(id);
  db().prepare(`UPDATE conductor_canvases SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Return constructed ConductorCanvas directly instead of re-querying
  return {
    id,
    name: data.name ?? existingRow.name,
    description: data.description !== undefined ? data.description : existingRow.description,
    layoutConfig: data.layoutConfig ?? JSON.parse(existingRow.layout_config || '{}'),
    sortOrder: data.sortOrder ?? existingRow.sort_order,
    createdAt: existingRow.created_at,
    updatedAt: now,
    projectPath: existingRow.project_path ?? null,
  };
}

// ============================================================
// Snapshot
// ============================================================

export function getCanvasSnapshot(canvasId: string): ConductorSnapshot | null {
  const canvas = db().prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(canvasId) as any;
  if (!canvas) return null;

  const elementRows = db().prepare('SELECT * FROM conductor_elements WHERE canvas_id = ?').all(canvasId) as any[];

  let elements: ConductorElement[];
  if (elementRows.length > 0) {
    elements = elementRows.map((e: any) => ({
      id: e.id,
      canvasId: e.canvas_id,
      elementKind: e.element_kind,
      position: safeParseJson(e.position, { x: 0, y: 0, w: 0, h: 0 }),
      config: safeParseJson(e.config, {}),
      vizSpec: e.viz_spec ? safeParseJson(e.viz_spec, null) : null,
      sourceCode: e.source_code,
      state: e.state,
      dataVersion: e.data_version,
      permissions: safeParseJson(e.permissions, {}),
      metadata: safeParseJson(e.metadata, { label: e.element_kind, tags: [], createdBy: 'user' }),
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    }));
  } else {
    const widgetRows = db().prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
    elements = widgetRows.map((w: any) => ({
      id: w.id,
      canvasId: w.canvas_id,
      elementKind: `widget/${w.type}`,
      position: { ...safeParseJson(w.position, {}), zIndex: 0, rotation: 0 },
      config: safeParseJson(w.config, {}),
      vizSpec: null,
      sourceCode: w.source_code,
      state: w.state,
      dataVersion: w.data_version,
      permissions: safeParseJson(w.permissions, {}),
      metadata: { label: `${w.kind}:${w.type}`, tags: [], createdBy: 'user' },
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }));
  }

  const widgetRows = db().prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
  const lastAction = db().prepare('SELECT MAX(id) as max_id FROM conductor_actions WHERE canvas_id = ?').get(canvasId) as { max_id: number | null };

  return {
    canvas: {
      id: canvas.id,
      name: canvas.name,
      description: canvas.description,
      layoutConfig: safeParseJson(canvas.layout_config, {}),
      sortOrder: canvas.sort_order,
      createdAt: canvas.created_at,
      updatedAt: canvas.updated_at,
      projectPath: canvas.project_path ?? null,
    },
    elements,
    widgets: widgetRows.map((w: any) => ({
      id: w.id,
      canvasId: w.canvas_id,
      kind: w.kind,
      type: w.type,
      position: safeParseJson(w.position, {}),
      config: safeParseJson(w.config, {}),
      data: safeParseJson(w.data, {}),
      dataVersion: w.data_version,
      sourceCode: w.source_code,
      state: w.state,
      permissions: safeParseJson(w.permissions, {}),
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    })),
    actionCursor: lastAction?.max_id ?? 0,
  };
}

// ============================================================
// Action Log
// ============================================================

export function writeActionLog(params: WriteActionLogParams): number {
  const result = db().prepare(
    `INSERT INTO conductor_actions (canvas_id, widget_id, actor, action_type, payload, result_patch, merged_from, reversible, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.canvasId,
    params.widgetId,
    params.actor,
    params.actionType,
    params.payload ? JSON.stringify(params.payload) : null,
    params.resultPatch ? JSON.stringify(params.resultPatch) : null,
    params.mergedFrom ?? null,
    params.reversible ?? 1,
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

// ============================================================
// Widget CRUD — removed (zero external references; conductor:action/undo/redo
// in db-handlers.ts inline their own SQL). Only element CRUD below is live.
// ============================================================

// ============================================================
// Element CRUD
// ============================================================

export function elementExists(elementId: string): boolean {
  const row = db().prepare('SELECT 1 FROM conductor_elements WHERE id = ?').get(elementId);
  return row !== undefined;
}

export function getElement(elementId: string, canvasId: string): ConductorElement | undefined {
  const row = db().prepare('SELECT * FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    elementKind: row.element_kind,
    position: safeParseJson<Record<string, unknown>>(row.position, {}),
    config: safeParseJson<Record<string, unknown>>(row.config, {}),
    vizSpec: safeParseJson<Record<string, unknown> | null>(row.viz_spec, null),
    sourceCode: row.source_code,
    state: row.state,
    dataVersion: row.data_version,
    permissions: safeParseJson<Record<string, unknown>>(row.permissions, {}),
    metadata: safeParseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertElement(elementId: string, canvasId: string, elementKind: string, position: Record<string, unknown>, config: Record<string, unknown>, vizSpec: Record<string, unknown> | null, permissions: Record<string, unknown>, metadata: Record<string, unknown>, now: number, nativeKind: string | null = null, sourceCode: string | null = null): void {
  db().prepare(
    `INSERT INTO conductor_elements (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 1, ?, ?, ?, ?)`
  ).run(elementId, canvasId, elementKind, nativeKind, JSON.stringify(position), JSON.stringify(config), vizSpec ? JSON.stringify(vizSpec) : null, sourceCode, JSON.stringify(permissions), JSON.stringify(metadata), now, now);
}

export function updateElementPosition(elementId: string, position: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
}

export function updateElementConfig(elementId: string, config: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, elementId);
}

export function updateElementMetadata(elementId: string, metadata: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), now, elementId);
}

export function updateElementVizSpec(elementId: string, vizSpec: Record<string, unknown> | null, now: number): void {
  db().prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(vizSpec ? JSON.stringify(vizSpec) : null, now, elementId);
}

export function updateElementSourceCode(elementId: string, sourceCode: string | null, now: number): void {
  db().prepare('UPDATE conductor_elements SET source_code = ?, updated_at = ? WHERE id = ?').run(sourceCode, now, elementId);
}

export function deleteElement(elementId: string): void {
  db().prepare('DELETE FROM conductor_elements WHERE id = ?').run(elementId);
}

export function findElementsByType(canvasId: string, nodeTypes: string[]): ConductorElement[] {
  const placeholders = nodeTypes.map(() => '?').join(',');
  const rows = db().prepare(
    `SELECT * FROM conductor_elements WHERE canvas_id = ? AND native_kind IN (${placeholders})`
  ).all(canvasId, ...nodeTypes) as any[];
  return rows.map((e: any) => ({
    id: e.id,
    canvasId: e.canvas_id,
    elementKind: e.element_kind,
    position: JSON.parse(e.position),
    config: JSON.parse(e.config),
    vizSpec: e.viz_spec ? JSON.parse(e.viz_spec) : null,
    sourceCode: e.source_code,
    state: e.state,
    dataVersion: e.data_version,
    permissions: JSON.parse(e.permissions),
    metadata: JSON.parse(e.metadata),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  }));
}

export function findAttachedConnectors(canvasId: string, nodeId: string): ConductorElement[] {
  const rows = db().prepare(
    `SELECT * FROM conductor_elements
     WHERE canvas_id = ? AND native_kind = 'connector'
       AND (json_extract(config, '$.source.nodeId') = ?
            OR json_extract(config, '$.target.nodeId') = ?)`
  ).all(canvasId, nodeId, nodeId) as any[];
  return rows.map((e: any) => ({
    id: e.id,
    canvasId: e.canvas_id,
    elementKind: e.element_kind,
    position: JSON.parse(e.position),
    config: JSON.parse(e.config),
    vizSpec: e.viz_spec ? JSON.parse(e.viz_spec) : null,
    sourceCode: e.source_code,
    state: e.state,
    dataVersion: e.data_version,
    permissions: JSON.parse(e.permissions),
    metadata: JSON.parse(e.metadata),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  }));
}

export function getMaxZIndex(canvasId: string): number {
  const row = db().prepare(
    `SELECT MAX(CAST(json_extract(position, '$.zIndex') AS INTEGER)) AS maxZ FROM conductor_elements WHERE canvas_id = ?`
  ).get(canvasId) as { maxZ: number | null } | undefined;
  return row?.maxZ ?? 0;
}

// OT Merge Utilities (mergeWidgetData/deepMerge/mergeArrays/isPlainObject/invertPatch)
// removed: these were duplicated inline in electron/ipc/db-handlers.ts and had
// zero external references. Plan 326-329 conductor IPC stays on the inline path.
