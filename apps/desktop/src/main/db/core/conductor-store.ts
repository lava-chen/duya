/**
 * conductor-store.ts — ConductorStore aggregate for `duya-core.db` (plan 534).
 *
 * Manages conductor subsystem tables:
 *   - Migration 25: conductor_canvases, conductor_canvas_groups,
 *                   conductor_widgets, conductor_actions, conductor_elements
 *
 * Includes data cleanup from legacy migration 34 (prune_disabled_element_kinds).
 */

import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './database';

// ─── Row Types ───────────────────────────────────────────────────────────────

export interface ConductorCanvasRow {
  id: string;
  name: string;
  description: string | null;
  layout_config: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  project_path: string | null;
  is_favorite: number;
  group_id: string | null;
  tags: string;
}

export interface ConductorCanvasGroupRow {
  id: string;
  name: string;
  sort_order: number;
  project_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConductorWidgetRow {
  id: string;
  canvas_id: string;
  kind: string;
  type: string;
  position: string;
  config: string;
  data: string;
  data_version: number;
  source_code: string | null;
  state: string;
  permissions: string;
  created_at: number;
  updated_at: number;
}

export interface ConductorElementRow {
  id: string;
  canvas_id: string;
  element_kind: string;
  native_kind: string | null;
  position: string;
  config: string;
  viz_spec: string | null;
  source_code: string | null;
  state: string;
  data_version: number;
  permissions: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface ConductorActionRow {
  id: number;
  canvas_id: string;
  widget_id: string | null;
  actor: string;
  action_type: string;
  payload: string | null;
  result_patch: string | null;
  merged_from: string | null;
  reversible: number;
  undone_at: number | null;
  ts: number;
}

// ─── DTO Types ──────────────────────────────────────────────────────────────

export interface ConductorCanvas {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  projectPath: string | null;
  isFavorite: boolean;
  groupId: string | null;
  tags: string[];
}

export interface ConductorCanvasGroup {
  id: string;
  name: string;
  sortOrder: number;
  projectPath: string | null;
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

// ─── JSON Helpers ───────────────────────────────────────────────────────────

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapCanvasRow(row: ConductorCanvasRow): ConductorCanvas {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    layoutConfig: safeParseJson<Record<string, unknown>>(row.layout_config, {}),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectPath: row.project_path ?? null,
    isFavorite: row.is_favorite === 1,
    groupId: row.group_id ?? null,
    tags: safeParseJson<string[]>(row.tags, []),
  };
}

function mapGroupRow(row: ConductorCanvasGroupRow): ConductorCanvasGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    projectPath: row.project_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWidgetRow(row: ConductorWidgetRow): ConductorWidget {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    kind: row.kind,
    type: row.type,
    position: safeParseJson<Record<string, unknown>>(row.position, {}),
    config: safeParseJson<Record<string, unknown>>(row.config, {}),
    data: safeParseJson<Record<string, unknown>>(row.data, {}),
    dataVersion: row.data_version,
    sourceCode: row.source_code,
    state: row.state,
    permissions: safeParseJson<Record<string, unknown>>(row.permissions, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapElementRow(row: ConductorElementRow): ConductorElement {
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

function mapActionRow(row: ConductorActionRow): ConductorAction {
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

// ─── Store Class ────────────────────────────────────────────────────────────

export class ConductorStore {
  /** Migration id=25: create conductor tables + cleanup disallowed element kinds. */
  static readonly migrations: Migration[] = [
    {
      id: 25,
      name: 'create_conductor_tables',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS conductor_canvases (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT,
            layout_config   TEXT NOT NULL DEFAULT '{}',
            sort_order      INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            project_path    TEXT,
            is_favorite     INTEGER NOT NULL DEFAULT 0,
            group_id        TEXT,
            tags            TEXT NOT NULL DEFAULT '[]'
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS conductor_canvas_groups (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            project_path    TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS conductor_widgets (
            id              TEXT PRIMARY KEY,
            canvas_id       TEXT NOT NULL,
            kind            TEXT NOT NULL,
            type            TEXT NOT NULL,
            position        TEXT NOT NULL DEFAULT '{}',
            config          TEXT NOT NULL DEFAULT '{}',
            data            TEXT NOT NULL DEFAULT '{}',
            data_version    INTEGER NOT NULL DEFAULT 1,
            source_code     TEXT,
            state           TEXT NOT NULL DEFAULT 'idle',
            permissions     TEXT NOT NULL DEFAULT '{"agentCanRead":true,"agentCanWrite":true,"agentCanDelete":false}',
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS conductor_actions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            canvas_id       TEXT NOT NULL,
            widget_id       TEXT,
            actor           TEXT NOT NULL,
            action_type     TEXT NOT NULL,
            payload         TEXT,
            result_patch    TEXT,
            merged_from     TEXT,
            reversible      INTEGER NOT NULL DEFAULT 1,
            ts              INTEGER NOT NULL,
            undone_at       INTEGER,
            FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS conductor_elements (
            id              TEXT PRIMARY KEY,
            canvas_id       TEXT NOT NULL,
            element_kind    TEXT NOT NULL,
            native_kind     TEXT,
            position        TEXT NOT NULL DEFAULT '{"x":0,"y":0,"w":4,"h":3,"zIndex":0,"rotation":0}',
            config          TEXT NOT NULL DEFAULT '{}',
            viz_spec        TEXT,
            source_code     TEXT,
            state           TEXT NOT NULL DEFAULT 'idle',
            data_version    INTEGER NOT NULL DEFAULT 1,
            permissions     TEXT NOT NULL DEFAULT '{"agentCanRead":true,"agentCanWrite":true,"agentCanDelete":false}',
            metadata        TEXT NOT NULL DEFAULT '{"label":"","tags":[],"createdBy":"user"}',
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            FOREIGN KEY (canvas_id) REFERENCES conductor_canvases(id) ON DELETE CASCADE
          )
        `);

        db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_canvas_groups_project ON conductor_canvas_groups(project_path)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_widgets_canvas ON conductor_widgets(canvas_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_elements_canvas ON conductor_elements(canvas_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_canvas ON conductor_actions(canvas_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conductor_actions_canvas_ts ON conductor_actions(canvas_id, ts)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_native_kind ON conductor_elements(canvas_id, native_kind)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_widgets_type ON conductor_widgets(type)`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conductor_canvases_project_path ON conductor_canvases(project_path) WHERE project_path IS NOT NULL`);

        const allowedKinds = [
          'native/sticky',
          'native/connector',
          'native/mindmap',
          'widget/task-list',
          'widget/note-pad',
          'widget/pomodoro',
          'widget/news-board',
        ];
        const allowedNativeKinds = ['sticky', 'connector', 'mindmap'];

        const kindPlaceholders = allowedKinds.map(() => '?').join(',');
        const nativePlaceholders = allowedNativeKinds.map(() => '?').join(',');

        const elementIds = db
          .prepare(
            `SELECT id FROM conductor_elements
             WHERE element_kind NOT IN (${kindPlaceholders})
                OR (native_kind IS NOT NULL
                    AND native_kind != ''
                    AND native_kind NOT IN (${nativePlaceholders}))`
          )
          .all(...allowedKinds, ...allowedNativeKinds) as Array<{ id: string }>;

        if (elementIds.length > 0) {
          const ids = elementIds.map((r) => r.id);
          const idPlaceholders = ids.map(() => '?').join(',');
          const txn = db.transaction(() => {
            db.prepare(`DELETE FROM conductor_widgets WHERE id IN (${idPlaceholders})`).run(...ids);
            db.prepare(`DELETE FROM conductor_actions WHERE widget_id IN (${idPlaceholders})`).run(...ids);
            db.prepare(`DELETE FROM conductor_elements WHERE id IN (${idPlaceholders})`).run(...ids);
          });
          txn();
        }
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ─── Canvases ──────────────────────────────────────────────────────────────

  listCanvases(): ConductorCanvas[] {
    const rows = this.db.prepare(
      'SELECT * FROM conductor_canvases ORDER BY sort_order, created_at DESC'
    ).all() as ConductorCanvasRow[];
    return rows.map(mapCanvasRow);
  }

  getCanvas(id: string): ConductorCanvas | null {
    const row = this.db.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as
      | ConductorCanvasRow
      | undefined;
    return row ? mapCanvasRow(row) : null;
  }

  getCanvasByProjectPath(projectPath: string): ConductorCanvas | null {
    const row = this.db
      .prepare('SELECT * FROM conductor_canvases WHERE project_path = ?')
      .get(projectPath) as ConductorCanvasRow | undefined;
    return row ? mapCanvasRow(row) : null;
  }

  createCanvas(data: { name: string; description?: string; projectPath?: string | null }): ConductorCanvas {
    const projectPath = data.projectPath ?? null;

    if (projectPath) {
      const existing = this.getCanvasByProjectPath(projectPath);
      if (existing) return existing;
    }

    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conductor_canvases
           (id, name, description, layout_config, sort_order, created_at, updated_at, project_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, data.name, data.description ?? null, '{}', 0, now, now, projectPath);

    return {
      id,
      name: data.name,
      description: data.description ?? null,
      layoutConfig: {},
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      projectPath,
      isFavorite: false,
      groupId: null,
      tags: [],
    };
  }

  updateCanvas(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      layoutConfig?: Record<string, unknown>;
      sortOrder?: number;
      isFavorite?: boolean;
      groupId?: string | null;
      tags?: string[];
    }
  ): ConductorCanvas | null {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.layoutConfig !== undefined) { fields.push('layout_config = ?'); values.push(JSON.stringify(data.layoutConfig)); }
    if (data.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(data.sortOrder); }
    if (data.isFavorite !== undefined) { fields.push('is_favorite = ?'); values.push(data.isFavorite ? 1 : 0); }
    if (data.groupId !== undefined) { fields.push('group_id = ?'); values.push(data.groupId); }
    if (data.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(data.tags)); }

    const existingRow = this.db.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as
      | ConductorCanvasRow
      | undefined;
    if (!existingRow) return null;

    values.push(id);
    this.db.prepare(`UPDATE conductor_canvases SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return {
      id,
      name: data.name ?? existingRow.name,
      description: data.description !== undefined ? data.description : existingRow.description,
      layoutConfig: data.layoutConfig ?? safeParseJson(existingRow.layout_config, {}),
      sortOrder: data.sortOrder ?? existingRow.sort_order,
      createdAt: existingRow.created_at,
      updatedAt: now,
      projectPath: existingRow.project_path ?? null,
      isFavorite: data.isFavorite ?? existingRow.is_favorite === 1,
      groupId: data.groupId !== undefined ? data.groupId : (existingRow.group_id ?? null),
      tags: data.tags ?? safeParseJson<string[]>(existingRow.tags, []),
    };
  }

  deleteCanvas(id: string): boolean {
    const result = this.db.prepare('DELETE FROM conductor_canvases WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  listGroups(projectPath?: string | null): ConductorCanvasGroup[] {
    const rows = projectPath
      ? (this.db
          .prepare(
            'SELECT * FROM conductor_canvas_groups WHERE project_path = ? OR project_path IS NULL ORDER BY sort_order, created_at DESC'
          )
          .all(projectPath) as ConductorCanvasGroupRow[])
      : (this.db
          .prepare('SELECT * FROM conductor_canvas_groups ORDER BY sort_order, created_at DESC')
          .all() as ConductorCanvasGroupRow[]);
    return rows.map(mapGroupRow);
  }

  getGroup(id: string): ConductorCanvasGroup | null {
    const row = this.db
      .prepare('SELECT * FROM conductor_canvas_groups WHERE id = ?')
      .get(id) as ConductorCanvasGroupRow | undefined;
    return row ? mapGroupRow(row) : null;
  }

  createGroup(data: { name: string; projectPath?: string | null }): ConductorCanvasGroup {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conductor_canvas_groups
           (id, name, sort_order, project_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, data.name, 0, data.projectPath ?? null, now, now);

    return {
      id,
      name: data.name,
      sortOrder: 0,
      projectPath: data.projectPath ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateGroup(id: string, data: { name?: string; sortOrder?: number }): ConductorCanvasGroup | null {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(data.sortOrder); }
    values.push(id);
    this.db.prepare(`UPDATE conductor_canvas_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = this.db.prepare('SELECT * FROM conductor_canvas_groups WHERE id = ?').get(id) as
      | ConductorCanvasGroupRow
      | undefined;
    return row ? mapGroupRow(row) : null;
  }

  deleteGroup(id: string): boolean {
    const txn = this.db.transaction(() => {
      this.db
        .prepare('UPDATE conductor_canvases SET group_id = NULL, updated_at = ? WHERE group_id = ?')
        .run(Date.now(), id);
      this.db.prepare('DELETE FROM conductor_canvas_groups WHERE id = ?').run(id);
    });
    txn();
    return true;
  }

  moveCanvasToGroup(canvasId: string, groupId: string | null): boolean {
    const result = this.db
      .prepare('UPDATE conductor_canvases SET group_id = ?, updated_at = ? WHERE id = ?')
      .run(groupId, Date.now(), canvasId);
    return result.changes > 0;
  }

  // ─── Widgets ───────────────────────────────────────────────────────────────

  listWidgets(): ConductorWidget[] {
    const rows = this.db.prepare('SELECT * FROM conductor_widgets').all() as ConductorWidgetRow[];
    return rows.map(mapWidgetRow);
  }

  getWidget(id: string): ConductorWidget | null {
    const row = this.db.prepare('SELECT * FROM conductor_widgets WHERE id = ?').get(id) as
      | ConductorWidgetRow
      | undefined;
    return row ? mapWidgetRow(row) : null;
  }

  createWidget(data: {
    canvasId: string;
    kind: string;
    type: string;
    position?: Record<string, unknown>;
    config?: Record<string, unknown>;
    data?: Record<string, unknown>;
    permissions?: Record<string, unknown>;
    sourceCode?: string | null;
  }): ConductorWidget {
    const id = randomUUID();
    const now = Date.now();
    const position = data.position ?? {};
    const config = data.config ?? {};
    const widgetData = data.data ?? {};
    const permissions = data.permissions ?? { agentCanRead: true, agentCanWrite: true, agentCanDelete: false };

    this.db
      .prepare(
        `INSERT INTO conductor_widgets
           (id, canvas_id, kind, type, position, config, data, permissions, source_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.canvasId,
        data.kind,
        data.type,
        JSON.stringify(position),
        JSON.stringify(config),
        JSON.stringify(widgetData),
        JSON.stringify(permissions),
        data.sourceCode ?? null,
        now,
        now
      );

    return {
      id,
      canvasId: data.canvasId,
      kind: data.kind,
      type: data.type,
      position,
      config,
      data: widgetData,
      dataVersion: 1,
      sourceCode: data.sourceCode ?? null,
      state: 'idle',
      permissions,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateWidget(
    id: string,
    data: {
      position?: Record<string, unknown>;
      config?: Record<string, unknown>;
      data?: Record<string, unknown>;
      state?: string;
      sourceCode?: string | null;
    }
  ): ConductorWidget | null {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.position !== undefined) { fields.push('position = ?'); values.push(JSON.stringify(data.position)); }
    if (data.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(data.config)); }
    if (data.data !== undefined) { fields.push('data = ?'); values.push(JSON.stringify(data.data)); }
    if (data.state !== undefined) { fields.push('state = ?'); values.push(data.state); }
    if (data.sourceCode !== undefined) { fields.push('source_code = ?'); values.push(data.sourceCode); }

    const existingRow = this.db.prepare('SELECT * FROM conductor_widgets WHERE id = ?').get(id) as
      | ConductorWidgetRow
      | undefined;
    if (!existingRow) return null;

    values.push(id);
    this.db.prepare(`UPDATE conductor_widgets SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return {
      id,
      canvasId: existingRow.canvas_id,
      kind: existingRow.kind,
      type: existingRow.type,
      position: data.position ?? safeParseJson(existingRow.position, {}),
      config: data.config ?? safeParseJson(existingRow.config, {}),
      data: data.data ?? safeParseJson(existingRow.data, {}),
      dataVersion: existingRow.data_version,
      sourceCode: data.sourceCode !== undefined ? data.sourceCode : existingRow.source_code,
      state: data.state ?? existingRow.state,
      permissions: safeParseJson(existingRow.permissions, {}),
      createdAt: existingRow.created_at,
      updatedAt: now,
    };
  }

  deleteWidget(id: string): boolean {
    const result = this.db.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listWidgetsByCanvas(canvasId: string): ConductorWidget[] {
    const rows = this.db
      .prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?')
      .all(canvasId) as ConductorWidgetRow[];
    return rows.map(mapWidgetRow);
  }

  // ─── Elements ─────────────────────────────────────────────────────────────

  listElements(): ConductorElement[] {
    const rows = this.db.prepare('SELECT * FROM conductor_elements').all() as ConductorElementRow[];
    return rows.map(mapElementRow);
  }

  getElement(id: string): ConductorElement | null {
    const row = this.db.prepare('SELECT * FROM conductor_elements WHERE id = ?').get(id) as
      | ConductorElementRow
      | undefined;
    return row ? mapElementRow(row) : null;
  }

  createElement(data: {
    canvasId: string;
    elementKind: string;
    nativeKind?: string | null;
    position?: Record<string, unknown>;
    config?: Record<string, unknown>;
    vizSpec?: Record<string, unknown> | null;
    permissions?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    sourceCode?: string | null;
  }): ConductorElement {
    const id = randomUUID();
    const now = Date.now();
    const position = data.position ?? { x: 0, y: 0, w: 4, h: 3, zIndex: 0, rotation: 0 };
    const config = data.config ?? {};
    const permissions = data.permissions ?? { agentCanRead: true, agentCanWrite: true, agentCanDelete: false };
    const metadata = data.metadata ?? { label: data.elementKind, tags: [], createdBy: 'user' };

    this.db
      .prepare(
        `INSERT INTO conductor_elements
           (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 1, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.canvasId,
        data.elementKind,
        data.nativeKind ?? null,
        JSON.stringify(position),
        JSON.stringify(config),
        data.vizSpec ? JSON.stringify(data.vizSpec) : null,
        data.sourceCode ?? null,
        JSON.stringify(permissions),
        JSON.stringify(metadata),
        now,
        now
      );

    return {
      id,
      canvasId: data.canvasId,
      elementKind: data.elementKind,
      position,
      config,
      vizSpec: data.vizSpec ?? null,
      sourceCode: data.sourceCode ?? null,
      state: 'idle',
      dataVersion: 1,
      permissions,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateElement(
    id: string,
    data: {
      position?: Record<string, unknown>;
      config?: Record<string, unknown>;
      vizSpec?: Record<string, unknown> | null;
      sourceCode?: string | null;
      state?: string;
    }
  ): ConductorElement | null {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.position !== undefined) { fields.push('position = ?'); values.push(JSON.stringify(data.position)); }
    if (data.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(data.config)); }
    if (data.vizSpec !== undefined) { fields.push('viz_spec = ?'); values.push(data.vizSpec ? JSON.stringify(data.vizSpec) : null); }
    if (data.sourceCode !== undefined) { fields.push('source_code = ?'); values.push(data.sourceCode); }
    if (data.state !== undefined) { fields.push('state = ?'); values.push(data.state); }

    const existingRow = this.db.prepare('SELECT * FROM conductor_elements WHERE id = ?').get(id) as
      | ConductorElementRow
      | undefined;
    if (!existingRow) return null;

    values.push(id);
    this.db.prepare(`UPDATE conductor_elements SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return {
      id,
      canvasId: existingRow.canvas_id,
      elementKind: existingRow.element_kind,
      position: data.position ?? safeParseJson(existingRow.position, {}),
      config: data.config ?? safeParseJson(existingRow.config, {}),
      vizSpec: data.vizSpec !== undefined ? data.vizSpec : safeParseJson(existingRow.viz_spec, null),
      sourceCode: data.sourceCode !== undefined ? data.sourceCode : existingRow.source_code,
      state: data.state ?? existingRow.state,
      dataVersion: existingRow.data_version,
      permissions: safeParseJson(existingRow.permissions, {}),
      metadata: safeParseJson(existingRow.metadata, {}),
      createdAt: existingRow.created_at,
      updatedAt: now,
    };
  }

  deleteElement(id: string): boolean {
    const result = this.db.prepare('DELETE FROM conductor_elements WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listElementsByCanvas(canvasId: string): ConductorElement[] {
    const rows = this.db
      .prepare('SELECT * FROM conductor_elements WHERE canvas_id = ?')
      .all(canvasId) as ConductorElementRow[];
    return rows.map(mapElementRow);
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  listActions(): ConductorAction[] {
    const rows = this.db.prepare('SELECT * FROM conductor_actions').all() as ConductorActionRow[];
    return rows.map(mapActionRow);
  }

  getAction(id: number): ConductorAction | null {
    const row = this.db.prepare('SELECT * FROM conductor_actions WHERE id = ?').get(id) as
      | ConductorActionRow
      | undefined;
    return row ? mapActionRow(row) : null;
  }

  createAction(data: {
    canvasId: string;
    widgetId?: string | null;
    actor: string;
    actionType: string;
    payload?: Record<string, unknown> | null;
    resultPatch?: Record<string, unknown> | null;
    reversible?: number;
    mergedFrom?: string | null;
  }): ConductorAction {
    const result = this.db
      .prepare(
        `INSERT INTO conductor_actions
           (canvas_id, widget_id, actor, action_type, payload, result_patch, merged_from, reversible, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.canvasId,
        data.widgetId ?? null,
        data.actor,
        data.actionType,
        data.payload ? JSON.stringify(data.payload) : null,
        data.resultPatch ? JSON.stringify(data.resultPatch) : null,
        data.mergedFrom ?? null,
        data.reversible ?? 1,
        Date.now()
      );

    return {
      id: Number(result.lastInsertRowid),
      canvasId: data.canvasId,
      widgetId: data.widgetId ?? null,
      actor: data.actor,
      actionType: data.actionType,
      payload: data.payload ? JSON.stringify(data.payload) : null,
      resultPatch: data.resultPatch ? JSON.stringify(data.resultPatch) : null,
      mergedFrom: data.mergedFrom ?? null,
      reversible: data.reversible ?? 1,
      undoneAt: null,
      ts: Date.now(),
    };
  }

  listActionsBySession(canvasId: string): ConductorAction[] {
    const rows = this.db
      .prepare('SELECT * FROM conductor_actions WHERE canvas_id = ? ORDER BY ts')
      .all(canvasId) as ConductorActionRow[];
    return rows.map(mapActionRow);
  }
}
