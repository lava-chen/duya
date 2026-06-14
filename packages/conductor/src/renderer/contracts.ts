import type { ComponentType } from "react";

export const WidgetKind = {
  builtin: "builtin",
  template: "template",
  dynamic: "dynamic",
} as const;
export type WidgetKind = (typeof WidgetKind)[keyof typeof WidgetKind];

export const WidgetState = {
  idle: "idle",
  loading: "loading",
  error: "error",
  "agent-editing": "agent-editing",
} as const;
export type WidgetState = (typeof WidgetState)[keyof typeof WidgetState];

export interface WidgetPermissions {
  agentCanRead: boolean;
  agentCanWrite: boolean;
  agentCanDelete: boolean;
}

export interface Position {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ElementKind = {
  "widget/task-list": "widget/task-list",
  "widget/note-pad": "widget/note-pad",
  "widget/pomodoro": "widget/pomodoro",
  "widget/news-board": "widget/news-board",
  "diagram/svg": "diagram/svg",
  "chart/bar": "chart/bar",
  "chart/line": "chart/line",
  "chart/pie": "chart/pie",
  "content/card": "content/card",
  "content/rich-text": "content/rich-text",
  "content/image": "content/image",
  "shape/rect": "shape/rect",
  "shape/circle": "shape/circle",
  "shape/connector": "shape/connector",
  "app/mini-app": "app/mini-app",
} as const;
export type ElementKind = (typeof ElementKind)[keyof typeof ElementKind] | `native/${string}`;

export const RenderMode = {
  react: "react",
  iframe: "iframe",
  "svg-native": "svg-native",
  canvas2d: "canvas2d",
} as const;
export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

export function getRenderModeForKind(kind: ElementKind): RenderMode {
  if (kind.startsWith("native/")) return "svg-native";
  if (kind.startsWith("widget/")) return "react";
  if (kind.startsWith("diagram/") || kind.startsWith("chart/")) return "iframe";
  if (kind.startsWith("shape/")) return "svg-native";
  if (kind === "app/mini-app") return "iframe";
  if (kind === "content/card" || kind === "content/image") return "iframe";
  if (kind === "content/rich-text") return "react";
  return "iframe";
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
export type ElementState = "idle" | "loading" | "rendering" | "error";

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
  createdBy: "user" | "agent";
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

export interface Point {
  x: number;
  y: number;
}

export const AnchorId = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  center: "center",
} as const;
export type AnchorId = (typeof AnchorId)[keyof typeof AnchorId];

export const Direction = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export interface ConnectorEndpoint {
  nodeId: string;
  anchorId: AnchorId;
}

export interface MindMapTreeNode {
  id: string;
  text: string;
  children: MindMapTreeNode[];
  collapsed?: boolean;
}

export interface AbsolutePositionResolver {
  (node: CanvasElement, allNodes: CanvasElement[]): Point;
}

export interface WidgetComponentProps {
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  readOnly: boolean;
}

export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetPosition extends WidgetSize {
  x: number;
  y: number;
}

export interface BuiltinWidgetDefinition {
  kind: "builtin";
  type: string;
  label: string;
  description?: string;
  component: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
}

export interface TemplateWidgetDefinition {
  kind: "template";
  type: string;
  label: string;
  description?: string;
  component: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
  manifestVersion: string;
  templateVersion: string;
  source: string;
  sourceUrl?: string;
  installedAt?: number;
}

export interface DynamicWidgetDefinition {
  kind: "dynamic";
  type: string;
  label: string;
  description?: string;
  component?: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
  renderMode: "iframe";
  sourceHtml: string;
  sanitizedHtml: string;
  warnings: string[];
  generatedAt: number;
  confirmedByUser: boolean;
}

export type WidgetDefinition =
  | BuiltinWidgetDefinition
  | TemplateWidgetDefinition
  | DynamicWidgetDefinition;
