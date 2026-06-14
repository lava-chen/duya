export const NodeType = {
  sticky: 'sticky',
  shape: 'shape',
  text: 'text',
  connector: 'connector',
  mindmap: 'mindmap',
  section: 'section',
  frame: 'frame',
  image: 'image',
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const AnchorId = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  center: 'center',
} as const;
export type AnchorId = (typeof AnchorId)[keyof typeof AnchorId];

export interface Point {
  x: number;
  y: number;
}

export const Direction = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export interface ConnectorEndpoint {
  nodeId: string;
  anchorId: AnchorId;
}

export interface ConnectorContent {
  source: ConnectorEndpoint;
  target: ConnectorEndpoint;
  curvature?: number;
  routingMode: 'bezier' | 'straight';
  waypoints?: Point[];
  style?: {
    stroke?: string;
    strokeWidth?: number;
    endMarker?: 'arrow' | 'none';
  };
}

export interface ShapeContent {
  shapeType: 'rect' | 'circle' | 'diamond' | 'triangle' | 'pill';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  label?: string;
  labelAlign?: 'center' | 'left' | 'right';
}

export interface TextContent {
  content: unknown;
  fontSize?: number;
  fontWeight?: string;
  align?: 'left' | 'center' | 'right';
  width?: number;
}

export interface StickyContent {
  text: string;
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'gray';
  fontSize?: number;
  width?: number;
}

export interface MindMapTreeNode {
  id: string;
  text: string;
  children: MindMapTreeNode[];
  collapsed?: boolean;
}

export interface MindMapContent {
  rootNode: MindMapTreeNode;
  layoutDirection: 'right' | 'left' | 'both' | 'tree';
  branchColors?: string[];
  _computed?: {
    layout?: Array<{ id: string; x: number; y: number }>;
  };
}

export interface SectionContent {
  title?: string;
  background?: string;
}

export interface FrameContent {
  title?: string;
  background?: string;
  clipContent?: boolean;
}

export interface ImageContent {
  assetId?: string;
  url?: string;
  objectFit?: 'fill' | 'contain' | 'cover' | 'none';
  alt?: string;
}

export type NodeContent =
  | { kind: 'sticky' } & StickyContent
  | { kind: 'shape' } & ShapeContent
  | { kind: 'text' } & TextContent
  | { kind: 'connector' } & ConnectorContent
  | { kind: 'mindmap' } & MindMapContent
  | { kind: 'section' } & SectionContent
  | { kind: 'frame' } & FrameContent
  | { kind: 'image' } & ImageContent;
