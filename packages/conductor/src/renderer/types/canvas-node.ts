export const NodeType = {
  sticky: 'sticky',
  document: 'document',
  shape: 'shape',
  text: 'text',
  connector: 'connector',
  section: 'section',
  frame: 'frame',
  image: 'image',
  file: 'file',
  group: 'group',
  link: 'link',
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

export interface ConnectorBindingPoint {
  /** Normalized horizontal position inside the bound element (0..1). */
  u: number;
  /** Normalized vertical position inside the bound element (0..1). */
  v: number;
}

export interface BoundConnectorEndpoint {
  kind: 'bound';
  nodeId: string;
  bindingPoint: ConnectorBindingPoint;
}

export interface FreeConnectorEndpoint {
  kind: 'free';
  point: Point;
}

/** Persisted before endpoint references and rendered for backward compatibility. */
export interface LegacyConnectorEndpoint {
  nodeId: string;
  anchorId: AnchorId;
  /** Normalized position along the selected edge (0..1). Defaults to 0.5. */
  edgePosition?: number;
}

export type ConnectorEndpoint =
  | BoundConnectorEndpoint
  | FreeConnectorEndpoint
  | LegacyConnectorEndpoint;

export type ConnectorRoutingMode = 'elbow' | 'curve';
export type ConnectorMarker = 'none' | 'arrow' | 'open-arrow' | 'circle' | 'diamond' | 'bar';

export interface CurveControlOffsets {
  source: Point;
  target: Point;
}

export interface ConnectorContent {
  source: ConnectorEndpoint;
  target: ConnectorEndpoint;
  curvature?: number;
  /**
   * `bezier` and `straight` are accepted by the renderer for legacy data.
   * New connectors persist only the user-facing elbow / curve modes.
   */
  routingMode: ConnectorRoutingMode | 'bezier' | 'straight';
  label?: string;
  labelPosition?: number;
  /** Elbow bend topology in canvas pixels. The generated SVG path is never persisted. */
  waypoints?: Point[];
  /** Additional on-path curve controls stored as endpoint-relative vectors. */
  curveControlOffsets?: CurveControlOffsets;
  /** Curve midpoint stored relative to the midpoint between the two endpoint references. */
  curveMidpointOffset?: Point;
  cornerRadius?: number;
  style?: {
    stroke?: string;
    strokeWidth?: number;
    endMarker?: 'arrow' | 'none';
  };
  // New top-level style fields (preferred over nested `style` for new data).
  // Fall back to `style.*` for backward compat when unset.
  strokeStyle?: 'solid' | 'dashed' | 'bold' | 'dotted';  // "dotted" is legacy-only
  color?: string;                                // default: var(--text-secondary)
  arrowStart?: boolean;                          // default: false
  arrowEnd?: boolean;                            // default: true
  startMarker?: ConnectorMarker;                 // default: "none"
  endMarker?: ConnectorMarker;                   // default: "arrow"
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

/** A Markdown file in the canvas project. `filePath` is project-relative. */
export interface DocumentContent {
  title: string;
  markdown: string;
  filePath: string;
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
  pdfPage?: number;
  pdfZoom?: number;
}

export interface GroupContent {
  title?: string;
  bgColor?: string;        // Frame background, default: transparent
  memberIds: string[];
}

export type LinkSnapshotMode =
  | 'none'
  | 'desktop-head'
  | 'desktop-full'
  | 'mobile-head'
  | 'mobile-full';

export interface LinkContent {
  linkType: 'url' | 'session' | 'canvas';
  title?: string;
  description?: string;
  url?: string;
  faviconUrl?: string;
  siteName?: string;
  targetId?: string;
  /** @deprecated Replaced by snapshotMode; kept for migration. */
  expanded?: boolean;
  /** @deprecated Replaced by snapshot-aware sizing; kept for migration. */
  expandedSize?: { w: number; h: number };
  snapshotMode?: LinkSnapshotMode;
  snapshotAssetId?: string;
  snapshotUrl?: string;
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
  | { kind: 'group' } & GroupContent
  | { kind: 'link' } & LinkContent;
