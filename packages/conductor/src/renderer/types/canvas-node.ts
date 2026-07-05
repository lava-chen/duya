export const NodeType = {
  sticky: 'sticky',
  shape: 'shape',
  text: 'text',
  connector: 'connector',
  section: 'section',
  frame: 'frame',
  image: 'image',
  file: 'file',
  group: 'group',
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
  // New top-level style fields (preferred over nested `style` for new data).
  // Fall back to `style.*` for backward compat when unset.
  strokeStyle?: 'solid' | 'dashed' | 'dotted';  // default: "solid"
  lineWidth?: number;                            // default: 2
  color?: string;                                // default: var(--text-secondary)
  arrowStart?: boolean;                          // default: false
  arrowEnd?: boolean;                            // default: true
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
  /**
   * Color key. Values map to the diagram module's semantic classes
   * (yellow→.s-chk Amber, blue→.s-proc, green→.s-agent, pink→.s-err Red,
   * purple→.s-msg, gray→.s-sub). See
   * `packages/conductor/src/renderer/components/native/sticky-colors.ts`
   * for the canonical palette. Note: `pink` renders as light red (.s-err).
   */
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'gray';
  fontSize?: number;
  width?: number;
  // New style fields (optional, fall back to defaults for old data).
  shape?: 'rect' | 'diamond' | 'ellipse';  // default: "rect"
  bgColor?: string;                          // default: existing sticky color
  borderStyle?: {
    color?: string;        // default: transparent
    width?: number;        // default: 0 (when 0, a 1px solid theme stroke is rendered instead)
    style?: 'solid' | 'dashed' | 'dotted';  // default: "solid"
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
  fileName?: string;
  objectFit?: 'fill' | 'contain' | 'cover' | 'none';
  alt?: string;
}

export interface FileContent {
  assetId?: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  url?: string;
}

export interface GroupContent {
  title?: string;
  bgColor?: string;        // Frame background, default: transparent
  memberIds: string[];
}

export type NodeContent =
  | { kind: 'sticky' } & StickyContent
  | { kind: 'shape' } & ShapeContent
  | { kind: 'text' } & TextContent
  | { kind: 'connector' } & ConnectorContent
  | { kind: 'section' } & SectionContent
  | { kind: 'frame' } & FrameContent
  | { kind: 'image' } & ImageContent
  | { kind: 'file' } & FileContent
  | { kind: 'group' } & GroupContent;
