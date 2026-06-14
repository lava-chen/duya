import { z } from 'zod';
import type { ConnectorEndpoint } from './canvas-node.js';

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

export const ElementKind = {
  'widget/task-list': 'widget/task-list',
  'widget/note-pad': 'widget/note-pad',
  'widget/pomodoro': 'widget/pomodoro',
  'widget/news-board': 'widget/news-board',
  'diagram/svg': 'diagram/svg',
  'chart/bar': 'chart/bar',
  'chart/line': 'chart/line',
  'chart/pie': 'chart/pie',
  'content/card': 'content/card',
  'content/rich-text': 'content/rich-text',
  'content/image': 'content/image',
  'shape/rect': 'shape/rect',
  'shape/circle': 'shape/circle',
  'shape/connector': 'shape/connector',
  'app/mini-app': 'app/mini-app',
} as const;
export type ElementKind = (typeof ElementKind)[keyof typeof ElementKind] | `native/${string}`;

export const RenderMode = {
  react: 'react',
  iframe: 'iframe',
  'svg-native': 'svg-native',
  canvas2d: 'canvas2d',
} as const;
export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

export function getRenderModeForKind(kind: ElementKind): RenderMode {
  if (kind.startsWith('native/')) return 'svg-native';
  if (kind.startsWith('widget/')) return 'react';
  if (kind.startsWith('diagram/') || kind.startsWith('chart/')) return 'iframe';
  if (kind.startsWith('shape/')) return 'svg-native';
  if (kind === 'app/mini-app') return 'iframe';
  if (kind === 'content/card' || kind === 'content/image') return 'iframe';
  if (kind === 'content/rich-text') return 'react';
  return 'iframe';
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
  | { action: 'element.update'; elementId: string; canvasId: string; vizSpec?: VizSpec | null; position?: Partial<CanvasPosition>; config?: Record<string, unknown> }
  | { action: 'element.delete'; elementId: string; canvasId: string }
  | { action: 'element.move'; elementId: string; canvasId: string; position: CanvasPosition }
  | { action: 'element.arrange'; canvasId: string; layout: Array<{ elementId: string; position: CanvasPosition }> }
  | { action: 'element.create_native'; canvasId: string; nodeType: string; position: CanvasPosition; content: Record<string, unknown>; style?: Record<string, unknown> }
  | { action: 'connector.create'; canvasId: string; source: ConnectorEndpoint; target: ConnectorEndpoint; curvature?: number; style?: Record<string, unknown> }
  | { action: 'element.update_content'; elementId: string; canvasId: string; content: Record<string, unknown> }
  | { action: 'element.reparent'; elementId: string; canvasId: string; parentId: string | null };

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
  state: string;
  data_version: number;
  source_code: string | null;
  permissions: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface DbConductorCanvasAction {
  canvasId: string;
  action: ConductorActionRequest;
}

export interface DbConductorCanvasState {
  canvas: ConductorCanvas;
  widgets: ConductorWidget[];
  elements: CanvasElement[];
  actionCursor: number;
}

export const ElementStateSchema = z.enum(['idle', 'loading', 'rendering', 'error']);
