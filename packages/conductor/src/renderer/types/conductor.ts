import { z } from 'zod';
import type { ConnectorEndpoint } from './canvas-node';

export const WidgetKind = {
  builtin: 'builtin',
  template: 'template',
  dynamic: 'dynamic',
} as const;
export type WidgetKind = (typeof WidgetKind)[keyof typeof WidgetKind];

export const WidgetState = {
  idle: 'idle',
  loading: 'loading',
  error: 'error',
  'agent-editing': 'agent-editing',
} as const;
export type WidgetState = (typeof WidgetState)[keyof typeof WidgetState];

export const Actor = {
  user: 'user',
  agent: 'agent',
  system: 'system',
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];

export interface Position {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetPermissions {
  agentCanRead: boolean;
  agentCanWrite: boolean;
  agentCanDelete: boolean;
}

// ============================================================
// V2 Element Types (Canvas Element Data Model)
// ============================================================

export const ElementKind = {
  'widget/task-list': 'widget/task-list',
  'widget/note-pad': 'widget/note-pad',
  'widget/pomodoro': 'widget/pomodoro',
  'widget/news-board': 'widget/news-board',
  'widget/dynamic': 'widget/dynamic',
} as const;
export type ElementKind = (typeof ElementKind)[keyof typeof ElementKind] | `native/${string}`;

export const RenderMode = {
  react: 'react',
  iframe: 'iframe',
  'svg-native': 'svg-native',
  canvas2d: 'canvas2d',
} as const;
export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

export function getRenderModeForKind(kind: ElementKind, hasSourceCode?: boolean): RenderMode {
  if (kind === 'widget/dynamic' || (hasSourceCode && kind.startsWith('widget/'))) {
    return 'iframe';
  }
  if (kind.startsWith('native/')) return 'svg-native';
  if (kind.startsWith('widget/')) return 'react';
  return 'react';
}

export function elementKindFromWidget(kind: WidgetKind, type: string): ElementKind {
  const candidate = `widget/${type}` as ElementKind;
  if (candidate in ElementKind) return candidate;
  return 'widget/task-list';
}

export interface CanvasPosition {
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  rotation: number;
}

export type ElementPermissions = WidgetPermissions;

export type ElementState = 'idle' | 'loading' | 'rendering' | 'error';

export interface VizSpec {
  kind: ElementKind;
  title?: string;
  description?: string;
  payload: Record<string, unknown>;
}

export interface ElementMetadata {
  label: string;
  description?: string;
  tags: string[];
  createdBy: 'user' | 'agent';
  sourceActionId?: number;
  parentId?: string | null;
  childIds?: string[];
  /** User-locked: excluded from explicit auto-layout. Default false. */
  locked?: boolean;
  /** Viewport-aware packing preference. Default 'mid'. */
  priority?: 'high' | 'mid' | 'low';
  /** Minimum size in grid units; zoom-to-fit will not shrink below this. */
  minSize?: { w: number; h: number };
  /** Resize handle behavior. Default 'free'. */
  resizeMode?: 'free' | 'ratio' | 'fixed';
}

export interface CanvasElement {
  id: string;
  canvasId: string;
  elementKind: ElementKind;
  native_kind?: string;
  position: CanvasPosition;
  config: Record<string, unknown>;
  state: ElementState;
  dataVersion: number;
  createdAt: number;
  updatedAt: number;
  vizSpec: VizSpec | null;
  sourceCode: string | null;
  permissions: ElementPermissions;
  metadata: ElementMetadata;
}

export interface ConductorV2Snapshot {
  canvas: ConductorCanvas;
  elements: CanvasElement[];
  widgets?: ConductorWidget[];
  actionCursor: number;
}

export interface ConductorCanvas {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Project path bound to this canvas (unique per project). Null for ad-hoc canvases. */
  projectPath?: string | null;
}

export interface ConductorWidget {
  id: string;
  canvasId: string;
  kind: WidgetKind;
  type: string;
  position: Position;
  config: Record<string, unknown>;
  data: Record<string, unknown>;
  dataVersion: number;
  sourceCode: string | null;
  state: WidgetState;
  permissions: WidgetPermissions;
  createdAt: number;
  updatedAt: number;
}

export interface ConductorAction {
  id: number;
  canvasId: string;
  widgetId: string | null;
  actor: Actor;
  actionType: string;
  payload: Record<string, unknown> | null;
  resultPatch: Record<string, unknown> | null;
  mergedFrom: string | null;
  reversible: number;
  ts: number;
  undoneAt: number | null;
}

export interface ConductorSnapshot {
  canvas: ConductorCanvas;
  widgets: ConductorWidget[];
  actionCursor: number;
}

export type ConductorActionRequest =
  | { action: 'canvas.rename'; canvasId: string; name: string }
  | { action: 'widget.create'; canvasId: string; kind: WidgetKind; type: string; position: Position; config?: Record<string, unknown>; data?: Record<string, unknown>; permissions?: WidgetPermissions }
  | { action: 'widget.move'; widgetId: string; canvasId: string; position: Position }
  | { action: 'widget.resize'; widgetId: string; canvasId: string; position: Position }
  | { action: 'widget.update_config'; widgetId: string; canvasId: string; config: Record<string, unknown> }
  | { action: 'widget.update_data'; widgetId: string; canvasId: string; data: Record<string, unknown>; clientTs?: number }
  | { action: 'widget.delete'; widgetId: string; canvasId: string }
  | { action: 'widget.restore'; widgetId: string; canvasId: string }
  | { action: 'element.create'; canvasId: string; elementKind: ElementKind; position: CanvasPosition; vizSpec?: VizSpec | null; config?: Record<string, unknown>; permissions?: ElementPermissions }
  | { action: 'element.update'; elementId: string; canvasId: string; vizSpec?: VizSpec | null; position?: Partial<CanvasPosition>; config?: Record<string, unknown>; metadata?: Partial<ElementMetadata> }
  | { action: 'element.delete'; elementId: string; canvasId: string }
  | { action: 'element.move'; elementId: string; canvasId: string; position: CanvasPosition }
  | { action: 'element.arrange'; canvasId: string; layout: Array<{ elementId: string; position: CanvasPosition }> }
  | { action: 'element.create_native'; canvasId: string; nodeType: string; position: CanvasPosition; content: Record<string, unknown>; style?: Record<string, unknown> }
  | { action: 'connector.create'; canvasId: string; source: ConnectorEndpoint; target: ConnectorEndpoint; curvature?: number; routingMode?: 'elbow' | 'curve'; label?: string; strokeStyle?: 'solid' | 'dashed' | 'dotted'; lineWidth?: number; color?: string; startMarker?: string; endMarker?: string; style?: Record<string, unknown> }
  | { action: 'element.update_content'; elementId: string; canvasId: string; content: Record<string, unknown> }
  | { action: 'element.reparent'; elementId: string; canvasId: string; parentId: string | null }
  | { action: 'group.create'; canvasId: string; memberIds: string[]; title?: string; bgColor?: string }
  | { action: 'group.ungroup'; canvasId: string; groupId: string }
  | { action: 'group.add_members'; canvasId: string; groupId: string; memberIds: string[] }
  | { action: 'group.remove_members'; canvasId: string; groupId: string; memberIds: string[] };

export const DbConductorCanvas = {
  id: '',
  name: '',
  description: null as string | null,
  layout_config: '{}',
  sort_order: 0,
  created_at: 0,
  updated_at: 0,
};

export interface DbConductorCanvas {
  id: string;
  name: string;
  description: string | null;
  layout_config: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface DbConductorWidget {
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

export interface DbConductorAction {
  id: number;
  canvas_id: string;
  widget_id: string | null;
  actor: string;
  action_type: string;
  payload: string | null;
  result_patch: string | null;
  merged_from: string | null;
  reversible: number;
  ts: number;
  undone_at: number | null;
}

export interface DbConductorElement {
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

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const CanvasPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  zIndex: z.number(),
  rotation: z.number(),
});

const WidgetPermissionsSchema = z.object({
  agentCanRead: z.boolean(),
  agentCanWrite: z.boolean(),
  agentCanDelete: z.boolean(),
});

const VizSpecSchema = z.object({
  kind: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

const ConnectorEndpointSchema = z.union([
  z.object({
    kind: z.literal('bound'),
    nodeId: z.string().min(1),
    bindingPoint: z.object({
      u: z.number().finite().min(0).max(1),
      v: z.number().finite().min(0).max(1),
    }),
  }),
  z.object({
    kind: z.literal('free'),
    point: z.object({ x: z.number().finite(), y: z.number().finite() }),
  }),
  z.object({
    nodeId: z.string().min(1),
    anchorId: z.enum(['top', 'bottom', 'left', 'right', 'center']),
    edgePosition: z.number().finite().min(0).max(1).optional(),
  }),
]);

export const ConductorActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('canvas.rename'), canvasId: z.string(), name: z.string().min(1) }),
  z.object({ action: z.literal('widget.create'), canvasId: z.string(), kind: z.enum(['builtin', 'template', 'dynamic']), type: z.string(), position: PositionSchema, config: z.record(z.string(), z.unknown()).optional(), data: z.record(z.string(), z.unknown()).optional(), permissions: WidgetPermissionsSchema.optional() }),
  z.object({ action: z.literal('widget.move'), widgetId: z.string(), canvasId: z.string(), position: PositionSchema }),
  z.object({ action: z.literal('widget.resize'), widgetId: z.string(), canvasId: z.string(), position: PositionSchema }),
  z.object({ action: z.literal('widget.update_config'), widgetId: z.string(), canvasId: z.string(), config: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('widget.update_data'), widgetId: z.string(), canvasId: z.string(), data: z.record(z.string(), z.unknown()), clientTs: z.number().optional() }),
  z.object({ action: z.literal('widget.delete'), widgetId: z.string(), canvasId: z.string() }),
  z.object({ action: z.literal('widget.restore'), widgetId: z.string(), canvasId: z.string() }),
  z.object({ action: z.literal('element.create'), canvasId: z.string(), elementKind: z.string(), position: CanvasPositionSchema, vizSpec: VizSpecSchema.nullable().optional(), config: z.record(z.string(), z.unknown()).optional(), permissions: WidgetPermissionsSchema.optional() }),
  z.object({ action: z.literal('element.update'), elementId: z.string(), canvasId: z.string(), vizSpec: VizSpecSchema.nullable().optional(), position: CanvasPositionSchema.partial().optional(), config: z.record(z.string(), z.unknown()).optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal('element.delete'), elementId: z.string(), canvasId: z.string() }),
  z.object({ action: z.literal('element.move'), elementId: z.string(), canvasId: z.string(), position: CanvasPositionSchema }),
  z.object({ action: z.literal('element.arrange'), canvasId: z.string(), layout: z.array(z.object({ elementId: z.string(), position: CanvasPositionSchema })) }),
  z.object({ action: z.literal('element.create_native'), canvasId: z.string(), nodeType: z.string(), position: CanvasPositionSchema, content: z.record(z.string(), z.unknown()), style: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal('connector.create'), canvasId: z.string(), source: ConnectorEndpointSchema, target: ConnectorEndpointSchema, curvature: z.number().optional(), routingMode: z.enum(['elbow', 'curve']).optional(), label: z.string().optional(), strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(), lineWidth: z.number().positive().optional(), color: z.string().optional(), startMarker: z.string().optional(), endMarker: z.string().optional(), style: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal('element.update_content'), elementId: z.string(), canvasId: z.string(), content: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('element.reparent'), elementId: z.string(), canvasId: z.string(), parentId: z.string().nullable() }),
  z.object({ action: z.literal('group.create'), canvasId: z.string(), memberIds: z.array(z.string()).min(1), title: z.string().optional(), bgColor: z.string().optional() }),
  z.object({ action: z.literal('group.ungroup'), canvasId: z.string(), groupId: z.string().min(1) }),
  z.object({ action: z.literal('group.add_members'), canvasId: z.string(), groupId: z.string().min(1), memberIds: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('group.remove_members'), canvasId: z.string(), groupId: z.string().min(1), memberIds: z.array(z.string()).min(1) }),
]);

export function validateActionRequest(data: unknown): ConductorActionRequest {
  return ConductorActionRequestSchema.parse(data) as ConductorActionRequest;
}

export function canvasFromDb(row: DbConductorCanvas): ConductorCanvas {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    layoutConfig: JSON.parse(row.layout_config),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function widgetFromDb(row: DbConductorWidget): ConductorWidget {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    kind: row.kind as WidgetKind,
    type: row.type,
    position: JSON.parse(row.position),
    config: JSON.parse(row.config),
    data: JSON.parse(row.data),
    dataVersion: row.data_version,
    sourceCode: row.source_code,
    state: row.state as WidgetState,
    permissions: JSON.parse(row.permissions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function actionFromDb(row: DbConductorAction): ConductorAction {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    widgetId: row.widget_id,
    actor: row.actor as Actor,
    actionType: row.action_type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    resultPatch: row.result_patch ? JSON.parse(row.result_patch) : null,
    mergedFrom: row.merged_from,
    reversible: row.reversible,
    ts: row.ts,
    undoneAt: row.undone_at,
  };
}

export function elementFromDb(row: DbConductorElement): CanvasElement {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    elementKind: row.element_kind as ElementKind,
    native_kind: row.native_kind ?? undefined,
    position: JSON.parse(row.position),
    config: JSON.parse(row.config),
    state: row.state as ElementState,
    dataVersion: row.data_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vizSpec: row.viz_spec ? JSON.parse(row.viz_spec) : null,
    sourceCode: row.source_code,
    permissions: JSON.parse(row.permissions),
    metadata: JSON.parse(row.metadata),
  };
}

export function defaultCanvasPosition(w: number = 4, h: number = 3): CanvasPosition {
  return { x: 0, y: 0, w, h, zIndex: 0, rotation: 0 };
}

export function defaultElementMetadata(label: string = '', createdBy: 'user' | 'agent' = 'user'): ElementMetadata {
  return { label, tags: [], createdBy };
}
