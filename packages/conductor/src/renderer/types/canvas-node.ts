/**
 * Connector geometry and link-card contracts shared by the canvas renderer,
 * the conductor IPC layer and the main-process link snapshot service.
 *
 * This module intentionally does NOT declare a node-content schema. Element
 * payloads live as `CanvasElement.config: Record<string, unknown>`
 * (`types/conductor.ts`), each component casts the keys it reads, and
 * `NativeElementRenderer.elementMap` is the single dispatch table for
 * `native_kind`. A parallel typed schema here had drifted from both — it
 * declared `ShapeContent.shapeType: 'circle' | 'pill'` while
 * `StickyElement.tsx` reads `config.shape` as
 * `"rect" | "rounded" | "ellipse" | "diamond" | "parallelogram" | "triangle" | "hexagon"`,
 * and it listed `section` / `frame` node types that no component renders —
 * so an agent following it silently produced a plain rectangle. With no
 * consumers it has been removed rather than re-specified; add new element
 * payload types only where a real consumer casts them.
 */
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
