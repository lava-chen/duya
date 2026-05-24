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

export function listCanvases(): ConductorCanvas[] {
  const rows = db().prepare(
    'SELECT * FROM conductor_canvases ORDER BY sort_order, created_at DESC'
  ).all() as any[];
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    layoutConfig: JSON.parse(r.layout_config),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function createCanvas(data: { name: string; description?: string }): ConductorCanvas {
  const id = randomUUID();
  const now = Date.now();
  db().prepare(
    'INSERT INTO conductor_canvases (id, name, description, layout_config, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, data.name, data.description ?? null, '{}', 0, now, now);

  // Return constructed ConductorCanvas directly instead of re-querying
  return {
    id,
    name: data.name,
    description: data.description ?? null,
    layoutConfig: {},
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
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
  };
}

export function deleteCanvas(id: string): void {
  db().prepare('DELETE FROM conductor_canvases WHERE id = ?').run(id);
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
  } else {
    const widgetRows = db().prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
    elements = widgetRows.map((w: any) => ({
      id: w.id,
      canvasId: w.canvas_id,
      elementKind: `widget/${w.type}`,
      position: { ...JSON.parse(w.position), zIndex: 0, rotation: 0 },
      config: JSON.parse(w.config),
      vizSpec: null,
      sourceCode: w.source_code,
      state: w.state,
      dataVersion: w.data_version,
      permissions: JSON.parse(w.permissions),
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
      layoutConfig: JSON.parse(canvas.layout_config),
      sortOrder: canvas.sort_order,
      createdAt: canvas.created_at,
      updatedAt: canvas.updated_at,
    },
    elements,
    widgets: widgetRows.map((w: any) => ({
      id: w.id,
      canvasId: w.canvas_id,
      kind: w.kind,
      type: w.type,
      position: JSON.parse(w.position),
      config: JSON.parse(w.config),
      data: JSON.parse(w.data),
      dataVersion: w.data_version,
      sourceCode: w.source_code,
      state: w.state,
      permissions: JSON.parse(w.permissions),
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

export function getActionLog(actionId: number): ConductorAction | undefined {
  const row = db().prepare('SELECT * FROM conductor_actions WHERE id = ?').get(actionId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    widgetId: row.widget_id,
    actor: row.actor,
    actionType: row.action_type,
    payload: row.payload,
    resultPatch: row.result_patch,
    mergedFrom: row.merged_from,
    reversible: row.reversible,
    undoneAt: row.undone_at,
    ts: row.ts,
  };
}

// ============================================================
// Widget CRUD
// ============================================================

export function getWidget(widgetId: string, canvasId: string): ConductorWidget | undefined {
  const row = db().prepare('SELECT * FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    kind: row.kind,
    type: row.type,
    position: JSON.parse(row.position),
    config: JSON.parse(row.config),
    data: JSON.parse(row.data),
    dataVersion: row.data_version,
    sourceCode: row.source_code,
    state: row.state,
    permissions: JSON.parse(row.permissions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertWidget(widgetId: string, canvasId: string, kind: string, type: string, position: Record<string, unknown>, config: Record<string, unknown>, data: Record<string, unknown>, permissions: Record<string, unknown>, now: number): void {
  db().prepare(
    `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?, ?)`
  ).run(widgetId, canvasId, kind, type, JSON.stringify(position), JSON.stringify(config), JSON.stringify(data), JSON.stringify(permissions), now, now);
}

export function insertWidgetElement(widgetId: string, canvasId: string, elementKind: string, canvasPosition: Record<string, unknown>, mergedConfig: Record<string, unknown>, permissions: Record<string, unknown>, metadata: Record<string, unknown>, now: number): void {
  db().prepare(
    `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`
  ).run(widgetId, canvasId, elementKind, JSON.stringify(canvasPosition), JSON.stringify(mergedConfig), JSON.stringify(permissions), JSON.stringify(metadata), now, now);
}

export function insertRestoredWidget(widgetId: string, canvasId: string, kind: string, type: string, position: Record<string, unknown>, config: Record<string, unknown>, data: Record<string, unknown>, dataVersion: number, permissions: Record<string, unknown>, now: number): void {
  db().prepare(
    `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
  ).run(widgetId, canvasId, kind, type, JSON.stringify(position), JSON.stringify(config), JSON.stringify(data), dataVersion, JSON.stringify(permissions), now, now);
}

export function updateWidgetPosition(widgetId: string, position: Record<string, unknown>, canvasPosition: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, widgetId);
  db().prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(canvasPosition), now, widgetId);
}

export function updateWidgetConfig(widgetId: string, config: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);
  db().prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);
}

export function getWidgetData(widgetId: string, canvasId: string) {
  return db().prepare('SELECT data, data_version FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as { data: string; data_version: number } | undefined;
}

export function updateWidgetData(widgetId: string, data: Record<string, unknown>, newVersion: number, now: number): void {
  db().prepare('UPDATE conductor_widgets SET data = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), newVersion, now, widgetId);
}

export function syncElementConfigFromWidget(widgetId: string, canvasId: string, mergedConfig: Record<string, unknown>, newVersion: number, now: number): void {
  db().prepare('UPDATE conductor_elements SET config = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedConfig), newVersion, now, widgetId);
}

export function deleteWidget(widgetId: string): void {
  db().prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
  db().prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
}

export function findLastDeleteAction(widgetId: string, canvasId: string): ConductorAction | undefined {
  const row = db().prepare(
    "SELECT * FROM conductor_actions WHERE widget_id = ? AND canvas_id = ? AND action_type = 'widget.delete' AND undone_at IS NULL ORDER BY ts DESC LIMIT 1"
  ).get(widgetId, canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    widgetId: row.widget_id,
    actor: row.actor,
    actionType: row.action_type,
    payload: row.payload,
    resultPatch: row.result_patch,
    mergedFrom: row.merged_from,
    reversible: row.reversible,
    undoneAt: row.undone_at,
    ts: row.ts,
  };
}

// ============================================================
// Element CRUD
// ============================================================

export function getElement(elementId: string, canvasId: string): ConductorElement | undefined {
  const row = db().prepare('SELECT * FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    elementKind: row.element_kind,
    position: JSON.parse(row.position),
    config: JSON.parse(row.config),
    vizSpec: row.viz_spec ? JSON.parse(row.viz_spec) : null,
    sourceCode: row.source_code,
    state: row.state,
    dataVersion: row.data_version,
    permissions: JSON.parse(row.permissions),
    metadata: JSON.parse(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertElement(elementId: string, canvasId: string, elementKind: string, position: Record<string, unknown>, config: Record<string, unknown>, vizSpec: Record<string, unknown> | null, permissions: Record<string, unknown>, metadata: Record<string, unknown>, now: number, nativeKind: string | null = null): void {
  db().prepare(
    `INSERT INTO conductor_elements (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'idle', 1, ?, ?, ?, ?)`
  ).run(elementId, canvasId, elementKind, nativeKind, JSON.stringify(position), JSON.stringify(config), vizSpec ? JSON.stringify(vizSpec) : null, JSON.stringify(permissions), JSON.stringify(metadata), now, now);
}

export function insertRestoredElement(elementId: string, canvasId: string, elementKind: string, position: Record<string, unknown>, config: Record<string, unknown>, vizSpec: Record<string, unknown> | null, state: string, dataVersion: number, permissions: Record<string, unknown>, metadata: Record<string, unknown>, createdAt: number, now: number): void {
  db().prepare(
    `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(elementId, canvasId, elementKind, JSON.stringify(position), JSON.stringify(config), vizSpec ? JSON.stringify(vizSpec) : null, state, dataVersion, JSON.stringify(permissions), JSON.stringify(metadata), createdAt, now);
}

export function updateElementPosition(elementId: string, position: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
}

export function updateElementConfig(elementId: string, config: Record<string, unknown>, now: number): void {
  db().prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, elementId);
}

export function updateElementVizSpec(elementId: string, vizSpec: Record<string, unknown> | null, now: number): void {
  db().prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(vizSpec ? JSON.stringify(vizSpec) : null, now, elementId);
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

// ============================================================
// Undo / Redo
// ============================================================

export function findLastReversibleAction(canvasId: string): ConductorAction | undefined {
  const row = db().prepare(
    'SELECT * FROM conductor_actions WHERE canvas_id = ? AND reversible = 1 AND undone_at IS NULL ORDER BY ts DESC LIMIT 1'
  ).get(canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    widgetId: row.widget_id,
    actor: row.actor,
    actionType: row.action_type,
    payload: row.payload,
    resultPatch: row.result_patch,
    mergedFrom: row.merged_from,
    reversible: row.reversible,
    undoneAt: row.undone_at,
    ts: row.ts,
  };
}

export function markActionUndone(actionId: number, now: number): void {
  db().prepare('UPDATE conductor_actions SET undone_at = ? WHERE id = ?').run(now, actionId);
}

export function findLastUndoneAction(canvasId: string): ConductorAction | undefined {
  const row = db().prepare(
    'SELECT * FROM conductor_actions WHERE canvas_id = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC LIMIT 1'
  ).get(canvasId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    canvasId: row.canvas_id,
    widgetId: row.widget_id,
    actor: row.actor,
    actionType: row.action_type,
    payload: row.payload,
    resultPatch: row.result_patch,
    mergedFrom: row.merged_from,
    reversible: row.reversible,
    undoneAt: row.undone_at,
    ts: row.ts,
  };
}

export function markActionRedone(actionId: number): void {
  db().prepare('UPDATE conductor_actions SET undone_at = NULL WHERE id = ?').run(actionId);
}

// ============================================================
// OT Merge Utilities
// ============================================================

export interface MergeContext {
  actor: string;
  clientTs?: number;
  serverVersion: number;
}

export interface MergeResult {
  data: Record<string, unknown>;
  mergedFrom: string | null;
}

export function mergeWidgetData(server: Record<string, unknown>, patch: Record<string, unknown>, context: MergeContext): MergeResult {
  if (context.actor === 'user') {
    return { data: deepMerge(server, patch, 'user'), mergedFrom: null };
  }

  if (context.clientTs && Date.now() - context.clientTs > 30000) {
    return { data: patch, mergedFrom: 'full_replace_stale' };
  }

  const merged = deepMerge(server, patch, 'server');
  const hasConflict = JSON.stringify(merged) !== JSON.stringify(patch);
  return {
    data: merged,
    mergedFrom: hasConflict ? 'agent_conflict' : null,
  };
}

export function deepMerge(server: Record<string, unknown>, patch: Record<string, unknown>, priority: 'user' | 'server'): Record<string, unknown> {
  const result = { ...server };

  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const serverVal = server[key];

    if (patchVal === undefined) continue;

    if (serverVal === undefined) {
      result[key] = patchVal;
      continue;
    }

    if (Array.isArray(patchVal) && Array.isArray(serverVal)) {
      result[key] = mergeArrays(serverVal as Record<string, unknown>[], patchVal as Record<string, unknown>[]);
    } else if (isPlainObject(patchVal) && isPlainObject(serverVal)) {
      result[key] = deepMerge(serverVal as Record<string, unknown>, patchVal as Record<string, unknown>, priority);
    } else if (serverVal !== patchVal) {
      result[key] = priority === 'user' ? patchVal : serverVal;
    }
  }

  return result;
}

export function mergeArrays(server: Record<string, unknown>[], patch: Record<string, unknown>[]): Record<string, unknown>[] {
  const idMap = new Map<string, Record<string, unknown>>();
  for (const item of server) {
    const id = item.id as string;
    if (id) idMap.set(id, { ...item });
  }
  for (const item of patch) {
    const id = item.id as string;
    if (id) {
      const existing = idMap.get(id);
      if (existing) {
        idMap.set(id, deepMerge(existing, item, 'server'));
      } else {
        idMap.set(id, { ...item });
      }
    }
  }
  return Array.from(idMap.values());
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invertPatch(patch: Record<string, unknown>, actionType: string): Record<string, unknown> {
  switch (actionType) {
    case 'canvas.rename':
      return { name: patch.prevName || 'Untitled' };
    case 'widget.create':
    case 'widget.delete':
    case 'widget.restore':
    case 'element.create':
    case 'element.delete':
      return {};
    case 'widget.move':
    case 'widget.resize':
      return { position: (patch as any).prevPosition || patch.position };
    case 'widget.update_config':
      return { config: (patch as any).prevConfig || patch.config };
    case 'widget.update_data':
      return { data: (patch as any).prevData || patch.data };
    case 'element.move':
      return { position: (patch as any).prevPosition || patch.position };
    case 'element.update':
      return {
        config: (patch as any).prevConfig || patch.config,
        vizSpec: (patch as any).prevVizSpec ?? patch.vizSpec,
        position: (patch as any).prevPosition || patch.position,
      };
    case 'element.arrange':
      return {};
  }
  return {};
}