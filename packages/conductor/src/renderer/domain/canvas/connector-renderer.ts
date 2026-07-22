import type { CanvasElement } from '../../types/conductor';
import type {
  AnchorId,
  ConnectorEndpoint,
  CurveControlOffsets,
  Point,
  Direction,
} from '../../types/canvas-node';
import { getAbsolutePosition } from '../../stores/conductor-store';
import { GRID_PX } from './units';

// Re-export for back-compat with code paths that imported GRID_PX
// from this module before the canonical units.ts module existed.
// New code should import directly from './units'.
export { GRID_PX };

export const directionVector: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const CONNECTOR_BINDING_GRID_PX = 8;

export type ConnectorEdge = Exclude<AnchorId, 'center'>;

export interface ResolvedConnectorEndpoint {
  referencePoint: Point;
  edgePoint: Point;
  direction: Direction;
  edge: ConnectorEdge | null;
  nodeId: string | null;
}

export function isBoundConnectorEndpoint(
  endpoint: ConnectorEndpoint | undefined,
): endpoint is Extract<ConnectorEndpoint, { kind: 'bound' }> {
  return Boolean(endpoint && 'kind' in endpoint && endpoint.kind === 'bound');
}

export function isFreeConnectorEndpoint(
  endpoint: ConnectorEndpoint | undefined,
): endpoint is Extract<ConnectorEndpoint, { kind: 'free' }> {
  return Boolean(endpoint && 'kind' in endpoint && endpoint.kind === 'free');
}

export function getConnectorEndpointNodeId(endpoint: ConnectorEndpoint | undefined): string | null {
  if (!endpoint || isFreeConnectorEndpoint(endpoint)) return null;
  return endpoint.nodeId;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

export interface CanvasPixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function getNodePixelRect(node: CanvasElement, allNodes: CanvasElement[]): CanvasPixelRect {
  const absolute = getAbsolutePosition(node, allNodes);
  return {
    x: (Number.isFinite(absolute.x) ? absolute.x : 0) * GRID_PX,
    y: (Number.isFinite(absolute.y) ? absolute.y : 0) * GRID_PX,
    w: (Number.isFinite(node.position.w) ? node.position.w : 4) * GRID_PX,
    h: (Number.isFinite(node.position.h) ? node.position.h : 3) * GRID_PX,
  };
}

export function getConnectorEndpointRect(
  endpoint: ConnectorEndpoint,
  allNodes: CanvasElement[],
): CanvasPixelRect | null {
  const nodeId = getConnectorEndpointNodeId(endpoint);
  const node = nodeId ? allNodes.find((candidate) => candidate.id === nodeId) : null;
  return node ? getNodePixelRect(node, allNodes) : null;
}

function edgeToDirection(edge: ConnectorEdge): Direction {
  return edge === 'top' ? 'up' : edge === 'bottom' ? 'down' : edge;
}

function offsetPointAlongDirection(point: Point, direction: Direction, distance: number): Point {
  const vector = directionVector[direction];
  return {
    x: point.x + vector.x * distance,
    y: point.y + vector.y * distance,
  };
}

export function createBoundConnectorEndpoint(
  point: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
  gridPx = CONNECTOR_BINDING_GRID_PX,
): Extract<ConnectorEndpoint, { kind: 'bound' }> {
  const rect = getNodePixelRect(node, allNodes);
  const safeGrid = Math.max(1, gridPx);
  const localX = Math.round((point.x - rect.x) / safeGrid) * safeGrid;
  const localY = Math.round((point.y - rect.y) / safeGrid) * safeGrid;
  return {
    kind: 'bound',
    nodeId: node.id,
    bindingPoint: {
      u: clampUnit(localX / Math.max(1, rect.w)),
      v: clampUnit(localY / Math.max(1, rect.h)),
    },
  };
}

export function createConnectorEndpointAtPoint(
  point: Point,
  node: CanvasElement | null,
  allNodes: CanvasElement[],
): ConnectorEndpoint {
  return node
    ? createBoundConnectorEndpoint(point, node, allNodes)
    : { kind: 'free', point: { x: point.x, y: point.y } };
}

export function resolveConnectorEndpoint(
  endpoint: ConnectorEndpoint,
  allNodes: CanvasElement[],
  otherPoint?: Point,
  clearance = 0,
): ResolvedConnectorEndpoint | null {
  const safeClearance = Math.max(0, Number.isFinite(clearance) ? clearance : 0);
  if (isFreeConnectorEndpoint(endpoint)) {
    if (!Number.isFinite(endpoint.point.x) || !Number.isFinite(endpoint.point.y)) return null;
    const point = { x: endpoint.point.x, y: endpoint.point.y };
    return {
      referencePoint: point,
      edgePoint: point,
      direction: otherPoint ? autoDirection(point, otherPoint) : 'right',
      edge: null,
      nodeId: null,
    };
  }

  const node = allNodes.find((candidate) => candidate.id === endpoint.nodeId);
  if (!node) return null;

  if (isBoundConnectorEndpoint(endpoint)) {
    const rect = getNodePixelRect(node, allNodes);
    const u = clampUnit(endpoint.bindingPoint.u);
    const v = clampUnit(endpoint.bindingPoint.v);
    const referencePoint = { x: rect.x + rect.w * u, y: rect.y + rect.h * v };
    const candidates: Array<{ edge: ConnectorEdge; distance: number; point: Point }> = [
      { edge: 'top', distance: v * rect.h, point: { x: referencePoint.x, y: rect.y } },
      { edge: 'bottom', distance: (1 - v) * rect.h, point: { x: referencePoint.x, y: rect.y + rect.h } },
      { edge: 'left', distance: u * rect.w, point: { x: rect.x, y: referencePoint.y } },
      { edge: 'right', distance: (1 - u) * rect.w, point: { x: rect.x + rect.w, y: referencePoint.y } },
    ];
    const nearest = candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
    const direction = edgeToDirection(nearest.edge);
    return {
      referencePoint,
      edgePoint: offsetPointAlongDirection(nearest.point, direction, safeClearance),
      direction,
      edge: nearest.edge,
      nodeId: endpoint.nodeId,
    };
  }

  const edgePosition = clampUnit(endpoint.edgePosition ?? 0.5);
  let resolvedAnchor = endpoint.anchorId;
  if (resolvedAnchor === 'center' && otherPoint) {
    const rect = getNodePixelRect(node, allNodes);
    const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const dx = otherPoint.x - center.x;
    const dy = otherPoint.y - center.y;
    const verticalGap = Math.abs(dy) - rect.h / 2;
    const horizontalGap = Math.abs(dx) - rect.w / 2;
    if (verticalGap >= 24) resolvedAnchor = dy >= 0 ? 'bottom' : 'top';
    else if (horizontalGap >= 24) resolvedAnchor = dx >= 0 ? 'right' : 'left';
  }
  const referencePoint = getAnchorPosition(node, resolvedAnchor, allNodes, edgePosition);
  const direction = anchorToDirection(resolvedAnchor) ?? autoDirection(referencePoint, otherPoint ?? referencePoint);
  const edgePoint = offsetPointAlongDirection(
    getConnectorEndpoint(node, resolvedAnchor, allNodes, otherPoint ?? referencePoint, edgePosition),
    direction,
    safeClearance,
  );
  const edge = resolvedAnchor === 'center' ? null : resolvedAnchor;
  return {
    referencePoint,
    edgePoint,
    direction,
    edge,
    nodeId: endpoint.nodeId,
  };
}

export function anchorToDirection(anchorId: AnchorId): Direction | null {
  switch (anchorId) {
    case 'top': return 'up';
    case 'bottom': return 'down';
    case 'left': return 'left';
    case 'right': return 'right';
    case 'center': return null;
  }
}

export function autoDirection(src: Point, tgt: Point): Direction {
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
}

export function getAnchorPosition(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
  edgePosition = 0.5,
): Point {
  // getAbsolutePosition returns grid units; convert to pixels so all
  // downstream geometry lives in one unit space.
  const gridAbs = getAbsolutePosition(node, allNodes);
  const x = Number.isFinite(gridAbs.x) ? gridAbs.x : 0;
  const y = Number.isFinite(gridAbs.y) ? gridAbs.y : 0;
  const abs = { x: x * GRID_PX, y: y * GRID_PX };
  const w = Number.isFinite(node.position.w) ? (node.position.w as number) : 4;
  const h = Number.isFinite(node.position.h) ? (node.position.h as number) : 3;
  const pxW = w * GRID_PX;
  const pxH = h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;
  const position = Math.max(0, Math.min(1, Number.isFinite(edgePosition) ? edgePosition : 0.5));

  switch (anchorId) {
    case 'top': return { x: abs.x + pxW * position, y: abs.y };
    case 'bottom': return { x: abs.x + pxW * position, y: abs.y + pxH };
    case 'left': return { x: abs.x, y: abs.y + pxH * position };
    case 'right': return { x: abs.x + pxW, y: abs.y + pxH * position };
    case 'center': return { x: cx, y: cy };
  }
}

const EDGE_OUTSET = 4;

function getRectEdgeIntersection(
  rect: { x: number; y: number; w: number; h: number },
  from: Point,
  to: Point,
): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  // Defensive: if either point is non-finite, fall back to the rect center
  // so the connector path does not render with NaN coordinates.
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y) ||
      !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    return { x: cx, y: cy };
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: rect.y + rect.h / 2 };
  }

  const dirX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const dirY = dy === 0 ? 0 : dy > 0 ? 1 : -1;

  const outsetRect = {
    x: rect.x - EDGE_OUTSET,
    y: rect.y - EDGE_OUTSET,
    w: rect.w + EDGE_OUTSET * 2,
    h: rect.h + EDGE_OUTSET * 2,
  };

  let t = Infinity;

  if (dx > 0) {
    t = Math.min(t, (outsetRect.x + outsetRect.w - from.x) / dx);
  } else if (dx < 0) {
    t = Math.min(t, (outsetRect.x - from.x) / dx);
  }

  if (dy > 0) {
    t = Math.min(t, (outsetRect.y + outsetRect.h - from.y) / dy);
  } else if (dy < 0) {
    t = Math.min(t, (outsetRect.y - from.y) / dy);
  }

  if (t === Infinity || t <= 0) {
    if (dirX > 0) return { x: outsetRect.x + outsetRect.w, y: cy };
    if (dirX < 0) return { x: outsetRect.x, y: cy };
    if (dirY > 0) return { x: cx, y: outsetRect.y + outsetRect.h };
    if (dirY < 0) return { x: cx, y: outsetRect.y };
    return { x: cx, y: cy };
  }

  return {
    x: from.x + dx * t,
    y: from.y + dy * t,
  };
}

export function getConnectorEndpoint(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
  otherPoint: Point,
  edgePosition = 0.5,
): Point {
  const gridAbs = getAbsolutePosition(node, allNodes);
  const x = Number.isFinite(gridAbs.x) ? gridAbs.x : 0;
  const y = Number.isFinite(gridAbs.y) ? gridAbs.y : 0;
  const abs = { x: x * GRID_PX, y: y * GRID_PX };
  const w = Number.isFinite(node.position.w) ? (node.position.w as number) : 4;
  const h = Number.isFinite(node.position.h) ? (node.position.h as number) : 3;
  const pxW = w * GRID_PX;
  const pxH = h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;

  if (anchorId !== 'center') {
    return getAnchorPosition(node, anchorId, allNodes, edgePosition);
  }

  const anchorPos = { x: cx, y: cy };
  const edge = getRectEdgeIntersection(
    { x: abs.x, y: abs.y, w: pxW, h: pxH },
    anchorPos,
    otherPoint,
  );
  return edge;
}

export function getBezierControlPoints(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  curvature = 0.4,
  offsets?: CurveControlOffsets,
): { source: Point; target: Point } {
  if (offsets &&
      Number.isFinite(offsets.source?.x) && Number.isFinite(offsets.source?.y) &&
      Number.isFinite(offsets.target?.x) && Number.isFinite(offsets.target?.y)) {
    return {
      source: { x: src.x + offsets.source.x, y: src.y + offsets.source.y },
      target: { x: tgt.x + offsets.target.x, y: tgt.y + offsets.target.y },
    };
  }

  const safeSrcDir = directionVector[srcDir] ? srcDir : autoDirection(src, tgt);
  const safeTgtDir = directionVector[tgtDir] ? tgtDir : autoDirection(tgt, src);
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);
  const srcVec = directionVector[safeSrcDir];
  const tgtVec = directionVector[safeTgtDir];
  const isOpposing = srcVec.x === -tgtVec.x && srcVec.y === -tgtVec.y;
  const minTension = Math.min(40, dist * 0.22);
  const maxTension = dist * (isOpposing ? 0.6 : 0.5);
  const baseTension = dist * curvature * (isOpposing ? 1.15 : 1);
  const tension = Math.min(maxTension, Math.max(minTension, baseTension));

  return {
    source: { x: src.x + srcVec.x * tension, y: src.y + srcVec.y * tension },
    target: { x: tgt.x + tgtVec.x * tension, y: tgt.y + tgtVec.y * tension },
  };
}

export function computeBezierPath(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  curvature = 0.4,
  offsets?: CurveControlOffsets,
): string {
  // Defensive: ensure all coordinates are finite and directions are valid.
  if (!Number.isFinite(src.x) || !Number.isFinite(src.y) ||
      !Number.isFinite(tgt.x) || !Number.isFinite(tgt.y)) {
    return '';
  }
  if (offsets) {
    const { source: cp1, target: cp2 } = getBezierControlPoints(
      src,
      srcDir,
      tgt,
      tgtDir,
      curvature,
      offsets,
    );
    return `M ${src.x} ${src.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${tgt.x} ${tgt.y}`;
  }
  const safeSrcDir = directionVector[srcDir] ? srcDir : autoDirection(src, tgt);
  const safeTgtDir = directionVector[tgtDir] ? tgtDir : autoDirection(tgt, src);
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);

  // Smooth, diagram-style tension:
  // - Always keep some curve even for short connections.
  // - Cap tension so long connections do not balloon out of control.
  // - When the two endpoints face each other (bottom→top, right→left),
  //   use a slightly larger share of the distance for a rounder S-curve.
  const srcVec = directionVector[safeSrcDir];
  const tgtVec = directionVector[safeTgtDir];
  const isOpposing = srcVec.x === -tgtVec.x && srcVec.y === -tgtVec.y;
  const minTension = Math.min(40, dist * 0.22);
  const maxTension = dist * (isOpposing ? 0.6 : 0.5);
  const baseTension = dist * curvature * (isOpposing ? 1.15 : 1);
  const tension = Math.min(maxTension, Math.max(minTension, baseTension));

  const cp1 = {
    x: src.x + srcVec.x * tension,
    y: src.y + srcVec.y * tension,
  };
  const cp2 = {
    x: tgt.x + tgtVec.x * tension,
    y: tgt.y + tgtVec.y * tension,
  };
  return `M ${src.x} ${src.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${tgt.x} ${tgt.y}`;
}

export function evaluateBezierPoint(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  curvature: number,
  t: number,
  offsets?: CurveControlOffsets,
): Point {
  // Defensive: ensure all coordinates are finite and directions are valid.
  if (!Number.isFinite(src.x) || !Number.isFinite(src.y) ||
      !Number.isFinite(tgt.x) || !Number.isFinite(tgt.y)) {
    return { x: 0, y: 0 };
  }
  if (offsets) {
    const controls = getBezierControlPoints(src, srcDir, tgt, tgtDir, curvature, offsets);
    return evaluateCubicBezierPoint(src, controls.source, controls.target, tgt, t);
  }
  const safeSrcDir = directionVector[srcDir] ? srcDir : autoDirection(src, tgt);
  const safeTgtDir = directionVector[tgtDir] ? tgtDir : autoDirection(tgt, src);
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);

  const srcVec = directionVector[safeSrcDir];
  const tgtVec = directionVector[safeTgtDir];
  const isOpposing = srcVec.x === -tgtVec.x && srcVec.y === -tgtVec.y;
  const minTension = Math.min(40, dist * 0.22);
  const maxTension = dist * (isOpposing ? 0.6 : 0.5);
  const baseTension = dist * curvature * (isOpposing ? 1.15 : 1);
  const tension = Math.min(maxTension, Math.max(minTension, baseTension));

  const cp1 = {
    x: src.x + srcVec.x * tension,
    y: src.y + srcVec.y * tension,
  };
  const cp2 = {
    x: tgt.x + tgtVec.x * tension,
    y: tgt.y + tgtVec.y * tension,
  };

  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: (uuu * src.x) + (3 * uu * t * cp1.x) + (3 * u * tt * cp2.x) + (ttt * tgt.x),
    y: (uuu * src.y) + (3 * uu * t * cp1.y) + (3 * u * tt * cp2.y) + (ttt * tgt.y),
  };
}

export interface ConnectorCurveGeometry {
  source: Point;
  sourceControl: Point;
  midpoint: Point;
  targetControl: Point;
  target: Point;
  activated: boolean;
}

export interface ClippedConnectorCurve {
  geometry: ConnectorCurveGeometry;
  path: string;
  sourcePoint: Point;
  targetPoint: Point;
  sourceT: number;
  targetT: number;
  sourceArrowDirectionPoint: Point;
  targetArrowDirectionPoint: Point;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

export function getDefaultCurveControls(
  source: Point,
  midpoint: Point,
  target: Point,
): { source: Point; target: Point } {
  return {
    source: lerpPoint(source, midpoint, 0.5),
    target: lerpPoint(midpoint, target, 0.5),
  };
}

export function computeConnectorCurveGeometry(
  source: Point,
  target: Point,
  midpointOffset?: Point,
  controlOffsets?: CurveControlOffsets,
): ConnectorCurveGeometry {
  const baseMidpoint = lerpPoint(source, target, 0.5);
  const activated = Boolean(midpointOffset || controlOffsets);
  const midpoint = midpointOffset
    ? { x: baseMidpoint.x + midpointOffset.x, y: baseMidpoint.y + midpointOffset.y }
    : baseMidpoint;

  if (!activated) {
    return {
      source,
      sourceControl: lerpPoint(source, midpoint, 0.5),
      midpoint,
      targetControl: lerpPoint(midpoint, target, 0.5),
      target,
      activated: false,
    };
  }

  const defaults = getDefaultCurveControls(source, midpoint, target);
  return {
    source,
    sourceControl: controlOffsets
      ? { x: source.x + controlOffsets.source.x, y: source.y + controlOffsets.source.y }
      : defaults.source,
    midpoint,
    targetControl: controlOffsets
      ? { x: target.x + controlOffsets.target.x, y: target.y + controlOffsets.target.y }
      : defaults.target,
    target,
    activated: true,
  };
}

interface CubicSegment {
  start: Point;
  sourceControl: Point;
  targetControl: Point;
  end: Point;
}

function evaluateCubicPoint(segment: CubicSegment, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * segment.start.x +
      3 * u * u * t * segment.sourceControl.x +
      3 * u * t * t * segment.targetControl.x +
      t * t * t * segment.end.x,
    y: u * u * u * segment.start.y +
      3 * u * u * t * segment.sourceControl.y +
      3 * u * t * t * segment.targetControl.y +
      t * t * t * segment.end.y,
  };
}

function getCurveKnots(geometry: ConnectorCurveGeometry): Point[] {
  return [
    geometry.source,
    geometry.sourceControl,
    geometry.midpoint,
    geometry.targetControl,
    geometry.target,
  ];
}

function getCatmullRomSegment(knots: Point[], index: number): CubicSegment {
  const start = knots[index];
  const end = knots[index + 1];
  const previous = knots[Math.max(0, index - 1)];
  const next = knots[Math.min(knots.length - 1, index + 2)];
  return {
    start,
    sourceControl: {
      x: start.x + (end.x - previous.x) / 6,
      y: start.y + (end.y - previous.y) / 6,
    },
    targetControl: {
      x: end.x - (next.x - start.x) / 6,
      y: end.y - (next.y - start.y) / 6,
    },
    end,
  };
}

export function evaluateConnectorCurvePoint(geometry: ConnectorCurveGeometry, t: number): Point {
  const clamped = Math.max(0, Math.min(1, t));
  const knots = getCurveKnots(geometry);
  const scaled = clamped * (knots.length - 1);
  const segmentIndex = Math.min(knots.length - 2, Math.floor(scaled));
  const localT = clamped === 1 ? 1 : scaled - segmentIndex;
  return evaluateCubicPoint(getCatmullRomSegment(knots, segmentIndex), localT);
}

function evaluateCubicDerivative(segment: CubicSegment, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * (
      u * u * (segment.sourceControl.x - segment.start.x) +
      2 * u * t * (segment.targetControl.x - segment.sourceControl.x) +
      t * t * (segment.end.x - segment.targetControl.x)
    ),
    y: 3 * (
      u * u * (segment.sourceControl.y - segment.start.y) +
      2 * u * t * (segment.targetControl.y - segment.sourceControl.y) +
      t * t * (segment.end.y - segment.targetControl.y)
    ),
  };
}

function sliceCubic(
  segment: CubicSegment,
  from: number,
  to: number,
): CubicSegment {
  const safeFrom = Math.max(0, Math.min(1, from));
  const safeTo = Math.max(safeFrom, Math.min(1, to));
  const slicedStart = evaluateCubicPoint(segment, safeFrom);
  const slicedEnd = evaluateCubicPoint(segment, safeTo);
  const sourceDerivative = evaluateCubicDerivative(segment, safeFrom);
  const targetDerivative = evaluateCubicDerivative(segment, safeTo);
  const scale = (safeTo - safeFrom) / 3;
  return {
    start: slicedStart,
    sourceControl: {
      x: slicedStart.x + sourceDerivative.x * scale,
      y: slicedStart.y + sourceDerivative.y * scale,
    },
    targetControl: {
      x: slicedEnd.x - targetDerivative.x * scale,
      y: slicedEnd.y - targetDerivative.y * scale,
    },
    end: slicedEnd,
  };
}

export function computeConnectorCurvePath(
  geometry: ConnectorCurveGeometry,
  fromT = 0,
  toT = 1,
): string {
  const startT = Math.max(0, Math.min(1, fromT));
  const endT = Math.max(startT, Math.min(1, toT));
  if (endT - startT < 0.000001) {
    const point = evaluateConnectorCurvePoint(geometry, startT);
    return `M ${formatCurveNumber(point.x)} ${formatCurveNumber(point.y)}`;
  }

  const knots = getCurveKnots(geometry);
  const segmentCount = knots.length - 1;
  const slices: CubicSegment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const segmentStartT = index / segmentCount;
    const segmentEndT = (index + 1) / segmentCount;
    if (endT <= segmentStartT || startT >= segmentEndT) continue;
    const localFrom = Math.max(0, (startT - segmentStartT) * segmentCount);
    const localTo = Math.min(1, (endT - segmentStartT) * segmentCount);
    slices.push(sliceCubic(getCatmullRomSegment(knots, index), localFrom, localTo));
  }
  if (slices.length === 0) return '';
  return slices.reduce((path, slice, index) => {
    const move = index === 0
      ? `M ${formatCurveNumber(slice.start.x)} ${formatCurveNumber(slice.start.y)} `
      : '';
    return `${path}${move}C ${formatCurveNumber(slice.sourceControl.x)} ${formatCurveNumber(slice.sourceControl.y)} ${formatCurveNumber(slice.targetControl.x)} ${formatCurveNumber(slice.targetControl.y)} ${formatCurveNumber(slice.end.x)} ${formatCurveNumber(slice.end.y)} `;
  }, '').trim();
}

function formatCurveNumber(value: number): number {
  return Number(value.toFixed(6));
}

function rectContainsPoint(rect: CanvasPixelRect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

function snapPointToRectBoundary(rect: CanvasPixelRect | null, point: Point): Point {
  if (!rect) return point;
  const edges = [
    { distance: Math.abs(point.x - rect.x), point: { x: rect.x, y: point.y } },
    { distance: Math.abs(point.x - (rect.x + rect.w)), point: { x: rect.x + rect.w, y: point.y } },
    { distance: Math.abs(point.y - rect.y), point: { x: point.x, y: rect.y } },
    { distance: Math.abs(point.y - (rect.y + rect.h)), point: { x: point.x, y: rect.y + rect.h } },
  ];
  return edges.reduce((nearest, edge) => edge.distance < nearest.distance ? edge : nearest).point;
}

function findCurveBoundaryParameter(
  geometry: ConnectorCurveGeometry,
  rect: CanvasPixelRect | null,
  fromSource: boolean,
): number {
  if (!rect) return fromSource ? 0 : 1;
  const endpointT = fromSource ? 0 : 1;
  const endpointPoint = evaluateConnectorCurvePoint(geometry, endpointT);
  if (!rectContainsPoint(rect, endpointPoint)) return endpointT;
  const boundaryDistance = Math.min(
    Math.abs(endpointPoint.x - rect.x),
    Math.abs(endpointPoint.x - (rect.x + rect.w)),
    Math.abs(endpointPoint.y - rect.y),
    Math.abs(endpointPoint.y - (rect.y + rect.h)),
  );
  if (boundaryDistance < 0.000001) {
    const adjacentT = fromSource ? 0.00001 : 0.99999;
    if (!rectContainsPoint(rect, evaluateConnectorCurvePoint(geometry, adjacentT))) return endpointT;
  }

  const sampleCount = 160;
  let insideT = endpointT;
  for (let index = 1; index <= sampleCount; index += 1) {
    const candidateT = fromSource ? index / sampleCount : 1 - index / sampleCount;
    const candidate = evaluateConnectorCurvePoint(geometry, candidateT);
    if (!rectContainsPoint(rect, candidate)) {
      let inside = insideT;
      let outside = candidateT;
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const middle = (inside + outside) / 2;
        if (rectContainsPoint(rect, evaluateConnectorCurvePoint(geometry, middle))) inside = middle;
        else outside = middle;
      }
      return (inside + outside) / 2;
    }
    insideT = candidateT;
  }
  return fromSource ? 1 : 0;
}

function getCurveOutwardDirectionPoint(
  geometry: ConnectorCurveGeometry,
  t: number,
  fromSource: boolean,
): Point {
  const tip = evaluateConnectorCurvePoint(geometry, t);
  const adjacentT = fromSource ? Math.min(1, t + 0.002) : Math.max(0, t - 0.002);
  const adjacent = evaluateConnectorCurvePoint(geometry, adjacentT);
  return {
    x: tip.x * 2 - adjacent.x,
    y: tip.y * 2 - adjacent.y,
  };
}

export function computeClippedConnectorCurve(
  geometry: ConnectorCurveGeometry,
  sourceRect: CanvasPixelRect | null,
  targetRect: CanvasPixelRect | null,
  clearance = 0,
): ClippedConnectorCurve {
  const safeClearance = Math.max(0, Number.isFinite(clearance) ? clearance : 0);
  const expand = (rect: CanvasPixelRect | null): CanvasPixelRect | null => rect && {
    x: rect.x - safeClearance,
    y: rect.y - safeClearance,
    w: rect.w + safeClearance * 2,
    h: rect.h + safeClearance * 2,
  };
  const sourceClipRect = expand(sourceRect);
  const targetClipRect = expand(targetRect);
  const sourceT = findCurveBoundaryParameter(geometry, sourceClipRect, true);
  const targetT = findCurveBoundaryParameter(geometry, targetClipRect, false);
  const safeTargetT = Math.max(sourceT, targetT);
  const sourcePoint = snapPointToRectBoundary(
    sourceClipRect,
    evaluateConnectorCurvePoint(geometry, sourceT),
  );
  const targetPoint = snapPointToRectBoundary(
    targetClipRect,
    evaluateConnectorCurvePoint(geometry, safeTargetT),
  );
  const sourceReferenceDirection = Math.hypot(
    geometry.source.x - sourcePoint.x,
    geometry.source.y - sourcePoint.y,
  ) > 0.01 ? geometry.source : getCurveOutwardDirectionPoint(geometry, sourceT, true);
  const targetReferenceDirection = Math.hypot(
    geometry.target.x - targetPoint.x,
    geometry.target.y - targetPoint.y,
  ) > 0.01 ? geometry.target : getCurveOutwardDirectionPoint(geometry, safeTargetT, false);
  return {
    geometry,
    path: computeConnectorCurvePath(geometry, sourceT, safeTargetT),
    sourcePoint,
    targetPoint,
    sourceT,
    targetT: safeTargetT,
    sourceArrowDirectionPoint: sourceReferenceDirection,
    targetArrowDirectionPoint: targetReferenceDirection,
  };
}

export function computeStraightPath(
  src: Point,
  tgt: Point,
): string {
  return `M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`;
}

export function evaluateCubicBezierPoint(
  src: Point,
  sourceControl: Point,
  targetControl: Point,
  tgt: Point,
  t: number,
): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  return {
    x: (uu * u * src.x) + (3 * uu * t * sourceControl.x) +
      (3 * u * tt * targetControl.x) + (tt * t * tgt.x),
    y: (uu * u * src.y) + (3 * uu * t * sourceControl.y) +
      (3 * u * tt * targetControl.y) + (tt * t * tgt.y),
  };
}

function isFinitePoint(point: Point | undefined): point is Point {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

export function simplifyOrthogonalPoints(points: Point[]): Point[] {
  const deduped = points.filter((point, index) => index === 0 || !pointsEqual(point, points[index - 1]));
  if (deduped.length < 3) return deduped;

  const simplified: Point[] = [deduped[0]];
  for (let index = 1; index < deduped.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = deduped[index];
    const next = deduped[index + 1];
    const sameX = Math.abs(previous.x - current.x) < 0.01 && Math.abs(current.x - next.x) < 0.01;
    const sameY = Math.abs(previous.y - current.y) < 0.01 && Math.abs(current.y - next.y) < 0.01;
    if (!sameX && !sameY) simplified.push(current);
  }
  simplified.push(deduped[deduped.length - 1]);
  return simplified;
}

/**
 * Move one visible elbow segment while keeping both connector endpoints fixed.
 * Terminal segments grow a short orthogonal dogleg instead of translating the
 * bound/free endpoint with the segment.
 */
export function moveElbowSegment(
  route: Point[],
  segmentIndex: number,
  orientation: OrthogonalSegmentOrientation,
  coordinate: number,
): Point[] {
  if (route.length < 2 || segmentIndex < 0 || segmentIndex >= route.length - 1) return route;
  const points = route.map((point) => ({ ...point }));
  const lastSegmentIndex = points.length - 2;

  if (segmentIndex > 0 && segmentIndex < lastSegmentIndex) {
    if (orientation === 'horizontal') {
      points[segmentIndex].y = coordinate;
      points[segmentIndex + 1].y = coordinate;
    } else {
      points[segmentIndex].x = coordinate;
      points[segmentIndex + 1].x = coordinate;
    }
    return simplifyOrthogonalPoints(points);
  }

  if (segmentIndex === 0) {
    const endpoint = points[0];
    const next = points[1];
    const length = orientation === 'horizontal'
      ? Math.abs(next.x - endpoint.x)
      : Math.abs(next.y - endpoint.y);
    const stubLength = Math.min(32, Math.max(16, length / 2));
    const direction = orientation === 'horizontal'
      ? Math.sign(next.x - endpoint.x) || 1
      : Math.sign(next.y - endpoint.y) || 1;
    const fixedStub = orientation === 'horizontal'
      ? { x: endpoint.x + direction * stubLength, y: endpoint.y }
      : { x: endpoint.x, y: endpoint.y + direction * stubLength };
    const movedSegment = orientation === 'horizontal'
      ? [{ x: fixedStub.x, y: coordinate }, { x: next.x, y: coordinate }]
      : [{ x: coordinate, y: fixedStub.y }, { x: coordinate, y: next.y }];
    return simplifyOrthogonalPoints([endpoint, fixedStub, ...movedSegment, ...points.slice(2)]);
  }

  const previous = points[points.length - 2];
  const endpoint = points[points.length - 1];
  const length = orientation === 'horizontal'
    ? Math.abs(previous.x - endpoint.x)
    : Math.abs(previous.y - endpoint.y);
  const stubLength = Math.min(32, Math.max(16, length / 2));
  const direction = orientation === 'horizontal'
    ? Math.sign(previous.x - endpoint.x) || -1
    : Math.sign(previous.y - endpoint.y) || -1;
  const fixedStub = orientation === 'horizontal'
    ? { x: endpoint.x + direction * stubLength, y: endpoint.y }
    : { x: endpoint.x, y: endpoint.y + direction * stubLength };
  const movedSegment = orientation === 'horizontal'
    ? [{ x: previous.x, y: coordinate }, { x: fixedStub.x, y: coordinate }]
    : [{ x: coordinate, y: previous.y }, { x: coordinate, y: fixedStub.y }];
  return simplifyOrthogonalPoints([...points.slice(0, -2), ...movedSegment, fixedStub, endpoint]);
}

export type OrthogonalSegmentOrientation = 'horizontal' | 'vertical';

export interface ElbowSegmentSnapResult {
  coordinate: number;
  snapped: boolean;
}

/** Snap a segment to the closest parallel segment on its own route. */
export function snapElbowSegmentToAdjacentParallel(
  proposedCoordinate: number,
  orientation: OrthogonalSegmentOrientation,
  route: Point[],
  segmentIndex: number,
  threshold = 12,
): ElbowSegmentSnapResult {
  const candidateIndexes = [segmentIndex - 2, segmentIndex + 2]
    .filter((index) => index >= 0 && index < route.length - 1);
  let coordinate = proposedCoordinate;
  let distance = Infinity;

  for (const index of candidateIndexes) {
    const start = route[index];
    const end = route[index + 1];
    const isParallel = orientation === 'horizontal'
      ? Math.abs(start.y - end.y) < 0.01
      : Math.abs(start.x - end.x) < 0.01;
    if (!isParallel) continue;
    const candidate = orientation === 'horizontal' ? start.y : start.x;
    const candidateDistance = Math.abs(candidate - proposedCoordinate);
    if (candidateDistance <= threshold && candidateDistance < distance) {
      coordinate = candidate;
      distance = candidateDistance;
    }
  }

  return { coordinate, snapped: distance !== Infinity };
}

export interface ConnectorArrowGeometry {
  left: Point;
  right: Point;
}

export function getConnectorArrowGeometry(
  tip: Point,
  directionPoint: Point,
  headLength = 10.5,
  halfWidth = 5.5,
): ConnectorArrowGeometry {
  const dx = directionPoint.x - tip.x;
  const dy = directionPoint.y - tip.y;
  const length = Math.hypot(dx, dy) || 1;
  const inward = { x: dx / length, y: dy / length };
  const perpendicular = { x: -inward.y, y: inward.x };
  const base = {
    x: tip.x - inward.x * headLength,
    y: tip.y - inward.y * headLength,
  };
  return {
    left: {
      x: base.x + perpendicular.x * halfWidth,
      y: base.y + perpendicular.y * halfWidth,
    },
    right: {
      x: base.x - perpendicular.x * halfWidth,
      y: base.y - perpendicular.y * halfWidth,
    },
  };
}

export function snapConnectorEdgePosition(
  position: number,
  peerPositions: number[],
  edgeLengthPx: number,
  thresholdPx = 14,
): number {
  const current = Math.max(0, Math.min(1, Number.isFinite(position) ? position : 0.5));
  const threshold = Math.min(0.12, thresholdPx / Math.max(1, edgeLengthPx));
  const positions = peerPositions
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(1, value)))
    .sort((a, b) => a - b);
  if (!positions.some((value) => Math.abs(value - current) < 0.0001)) {
    positions.push(current);
    positions.sort((a, b) => a - b);
  }
  const currentIndex = positions.reduce((bestIndex, value, index) =>
    Math.abs(value - current) < Math.abs(positions[bestIndex] - current) ? index : bestIndex, 0);
  let start = currentIndex;
  let end = currentIndex;
  while (start > 0 && positions[start] - positions[start - 1] <= threshold) start -= 1;
  while (end < positions.length - 1 && positions[end + 1] - positions[end] <= threshold) end += 1;
  const cluster = positions.slice(start, end + 1);
  if (cluster.length <= 1) return current;
  const average = cluster.reduce((sum, value) => sum + value, 0) / cluster.length;
  return Math.round(average * 10_000) / 10_000;
}

function intervalGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const aMin = Math.min(aStart, aEnd);
  const aMax = Math.max(aStart, aEnd);
  const bMin = Math.min(bStart, bEnd);
  const bMax = Math.max(bStart, bEnd);
  return Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax));
}

/**
 * Snap a dragged elbow segment onto a nearby parallel segment.
 *
 * The coordinate is in canvas pixels. Callers should divide the desired
 * screen-space threshold by the current zoom before passing it here.
 */
export function snapElbowSegmentCoordinate(
  proposedCoordinate: number,
  orientation: OrthogonalSegmentOrientation,
  movingStart: Point,
  movingEnd: Point,
  candidateRoutes: Point[][],
  threshold = 12,
): ElbowSegmentSnapResult {
  let bestCoordinate = proposedCoordinate;
  let bestDistance = Infinity;
  let bestAlongGap = Infinity;
  const movingAlongStart = orientation === 'horizontal' ? movingStart.x : movingStart.y;
  const movingAlongEnd = orientation === 'horizontal' ? movingEnd.x : movingEnd.y;

  for (const route of candidateRoutes) {
    for (let index = 0; index < route.length - 1; index += 1) {
      const start = route[index];
      const end = route[index + 1];
      if (!isFinitePoint(start) || !isFinitePoint(end)) continue;
      const isHorizontal = Math.abs(start.y - end.y) < 0.01;
      const isVertical = Math.abs(start.x - end.x) < 0.01;
      if ((orientation === 'horizontal' && !isHorizontal) ||
          (orientation === 'vertical' && !isVertical)) continue;

      const candidateCoordinate = orientation === 'horizontal' ? start.y : start.x;
      const distance = Math.abs(candidateCoordinate - proposedCoordinate);
      if (distance > threshold) continue;

      const candidateAlongStart = orientation === 'horizontal' ? start.x : start.y;
      const candidateAlongEnd = orientation === 'horizontal' ? end.x : end.y;
      const alongGap = intervalGap(
        movingAlongStart,
        movingAlongEnd,
        candidateAlongStart,
        candidateAlongEnd,
      );
      if (alongGap > threshold) continue;

      if (distance < bestDistance || (Math.abs(distance - bestDistance) < 0.01 && alongGap < bestAlongGap)) {
        bestCoordinate = candidateCoordinate;
        bestDistance = distance;
        bestAlongGap = alongGap;
      }
    }
  }

  return {
    coordinate: bestCoordinate,
    snapped: bestDistance !== Infinity,
  };
}

export function orthogonalizeElbowPoints(points: Point[]): Point[] {
  if (points.length < 2) return points;
  const result: Point[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = result[result.length - 1];
    const next = points[index];
    if (Math.abs(previous.x - next.x) > 0.01 && Math.abs(previous.y - next.y) > 0.01) {
      result.push({ x: next.x, y: previous.y });
    }
    result.push(next);
  }
  return simplifyOrthogonalPoints(result);
}

export function computeElbowRoutePoints(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  waypoints?: Point[],
  stubLength = 32,
  laneCoordinate?: number,
): Point[] {
  const savedWaypoints = waypoints?.filter(isFinitePoint).map((point) => ({ ...point })) ?? [];
  const srcVec = directionVector[srcDir];
  const tgtVec = directionVector[tgtDir];
  const srcStub = {
    x: src.x + srcVec.x * stubLength,
    y: src.y + srcVec.y * stubLength,
  };
  const tgtStub = {
    x: tgt.x + tgtVec.x * stubLength,
    y: tgt.y + tgtVec.y * stubLength,
  };
  const srcHorizontal = srcDir === 'left' || srcDir === 'right';
  const tgtHorizontal = tgtDir === 'left' || tgtDir === 'right';

  if (savedWaypoints.length > 0) {
    if (savedWaypoints.length === 1) {
      const waypoint = savedWaypoints[0];
      if (srcHorizontal === tgtHorizontal) {
        const lane = srcHorizontal ? waypoint.x : waypoint.y;
        return computeElbowRoutePoints(src, srcDir, tgt, tgtDir, undefined, stubLength, lane);
      }

      if (!srcHorizontal && tgtHorizontal) {
        const lane = tgtDir === 'left'
          ? Math.min(waypoint.x, tgtStub.x)
          : Math.max(waypoint.x, tgtStub.x);
        return simplifyOrthogonalPoints([
          src,
          srcStub,
          { x: lane, y: srcStub.y },
          { x: lane, y: tgtStub.y },
          tgtStub,
          tgt,
        ]);
      }

      const lane = tgtDir === 'up'
        ? Math.min(waypoint.y, tgtStub.y)
        : Math.max(waypoint.y, tgtStub.y);
      return simplifyOrthogonalPoints([
        src,
        srcStub,
        { x: srcStub.x, y: lane },
        { x: tgtStub.x, y: lane },
        tgtStub,
        tgt,
      ]);
    }

    const first = savedWaypoints[0];
    const last = savedWaypoints[savedWaypoints.length - 1];
    if (srcHorizontal) {
      first.y = src.y;
      first.x = srcDir === 'left'
        ? Math.min(first.x, srcStub.x)
        : Math.max(first.x, srcStub.x);
    } else {
      first.x = src.x;
      first.y = srcDir === 'up'
        ? Math.min(first.y, srcStub.y)
        : Math.max(first.y, srcStub.y);
    }
    if (tgtHorizontal) {
      last.y = tgt.y;
      last.x = tgtDir === 'left'
        ? Math.min(last.x, tgtStub.x)
        : Math.max(last.x, tgtStub.x);
    } else {
      last.x = tgt.x;
      last.y = tgtDir === 'up'
        ? Math.min(last.y, tgtStub.y)
        : Math.max(last.y, tgtStub.y);
    }
    return orthogonalizeElbowPoints([src, ...savedWaypoints, tgt]);
  }

  if (srcHorizontal && tgtHorizontal) {
    const outerX = srcDir === tgtDir
      ? srcDir === 'right'
        ? Math.max(srcStub.x, tgtStub.x)
        : Math.min(srcStub.x, tgtStub.x)
      : (srcStub.x + tgtStub.x) / 2;
    const midX = laneCoordinate === undefined
      ? outerX
      : srcDir === tgtDir
        ? srcDir === 'right'
          ? Math.max(outerX, laneCoordinate)
          : Math.min(outerX, laneCoordinate)
        : laneCoordinate;
    return simplifyOrthogonalPoints([
      src,
      srcStub,
      { x: midX, y: srcStub.y },
      { x: midX, y: tgtStub.y },
      tgtStub,
      tgt,
    ]);
  }

  if (!srcHorizontal && !tgtHorizontal) {
    const outerY = srcDir === tgtDir
      ? srcDir === 'down'
        ? Math.max(srcStub.y, tgtStub.y)
        : Math.min(srcStub.y, tgtStub.y)
      : (srcStub.y + tgtStub.y) / 2;
    const midY = laneCoordinate === undefined
      ? outerY
      : srcDir === tgtDir
        ? srcDir === 'down'
          ? Math.max(outerY, laneCoordinate)
          : Math.min(outerY, laneCoordinate)
        : laneCoordinate;
    return simplifyOrthogonalPoints([
      src,
      srcStub,
      { x: srcStub.x, y: midY },
      { x: tgtStub.x, y: midY },
      tgtStub,
      tgt,
    ]);
  }

  const corner = srcHorizontal
    ? { x: srcStub.x, y: tgtStub.y }
    : { x: tgtStub.x, y: srcStub.y };
  return simplifyOrthogonalPoints([src, srcStub, corner, tgtStub, tgt]);
}

export function computeRoundedElbowPath(points: Point[], cornerRadius = 14): string {
  const safePoints = simplifyOrthogonalPoints(points.filter(isFinitePoint));
  if (safePoints.length < 2) return '';
  if (safePoints.length === 2) return computeStraightPath(safePoints[0], safePoints[1]);

  const commands: string[] = [`M ${safePoints[0].x} ${safePoints[0].y}`];
  for (let index = 1; index < safePoints.length - 1; index += 1) {
    const previous = safePoints[index - 1];
    const current = safePoints[index];
    const next = safePoints[index + 1];
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.max(0, Math.min(cornerRadius, incoming / 2, outgoing / 2));
    if (radius < 0.5) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }
    const before = {
      x: current.x + ((previous.x - current.x) / incoming) * radius,
      y: current.y + ((previous.y - current.y) / incoming) * radius,
    };
    const after = {
      x: current.x + ((next.x - current.x) / outgoing) * radius,
      y: current.y + ((next.y - current.y) / outgoing) * radius,
    };
    commands.push(`L ${before.x} ${before.y}`);
    commands.push(`Q ${current.x} ${current.y} ${after.x} ${after.y}`);
  }
  const last = safePoints[safePoints.length - 1];
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(' ');
}

export function getPolylineMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const lengths = points.slice(0, -1).map((point, index) =>
    Math.hypot(points[index + 1].x - point.x, points[index + 1].y - point.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length === 0 ? 0 : remaining / length;
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

export function autoSelectAnchor(
  cursorPos: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
): AnchorId {
  return autoSelectAttachment(cursorPos, node, allNodes).anchorId;
}

export function autoSelectAttachment(
  cursorPos: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
): { anchorId: Exclude<AnchorId, 'center'>; edgePosition: number } {
  const gridAbs = getAbsolutePosition(node, allNodes);
  const abs = { x: gridAbs.x * GRID_PX, y: gridAbs.y * GRID_PX };
  const pxW = node.position.w * GRID_PX;
  const pxH = node.position.h * GRID_PX;
  const horizontalPosition = Math.max(0, Math.min(1, (cursorPos.x - abs.x) / Math.max(pxW, 1)));
  const verticalPosition = Math.max(0, Math.min(1, (cursorPos.y - abs.y) / Math.max(pxH, 1)));
  const edges: Array<{
    anchorId: Exclude<AnchorId, 'center'>;
    distance: number;
    edgePosition: number;
  }> = [
    { anchorId: 'top', distance: Math.abs(cursorPos.y - abs.y), edgePosition: horizontalPosition },
    { anchorId: 'bottom', distance: Math.abs(cursorPos.y - (abs.y + pxH)), edgePosition: horizontalPosition },
    { anchorId: 'left', distance: Math.abs(cursorPos.x - abs.x), edgePosition: verticalPosition },
    { anchorId: 'right', distance: Math.abs(cursorPos.x - (abs.x + pxW)), edgePosition: verticalPosition },
  ];
  return edges.reduce((best, edge) => edge.distance < best.distance ? edge : best);
}

/**
 * Pick sensible side anchors for a new connector based on the relative
 * positions of the source and target nodes. This produces the natural
 * S-curve seen in diagram tools: a vertical stack exits bottom→top, a
 * horizontal row exits right→left, etc. Falls back to center for
 * overlapping or nearly-diagonal cases.
 */
export function selectAutoAnchors(
  source: CanvasElement,
  target: CanvasElement,
  allNodes: CanvasElement[],
): { sourceAnchor: AnchorId; targetAnchor: AnchorId } {
  const srcAbs = getAbsolutePosition(source, allNodes);
  const tgtAbs = getAbsolutePosition(target, allNodes);
  const srcCenter = {
    x: srcAbs.x * GRID_PX + (source.position.w * GRID_PX) / 2,
    y: srcAbs.y * GRID_PX + (source.position.h * GRID_PX) / 2,
  };
  const tgtCenter = {
    x: tgtAbs.x * GRID_PX + (target.position.w * GRID_PX) / 2,
    y: tgtAbs.y * GRID_PX + (target.position.h * GRID_PX) / 2,
  };

  const dx = tgtCenter.x - srcCenter.x;
  const dy = tgtCenter.y - srcCenter.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Overlapping nodes — center anchor lets the edge-intersection logic
  // pick the best exit point.
  if (adx < 4 && ady < 4) {
    return { sourceAnchor: 'center', targetAnchor: 'center' };
  }

  if (adx > ady) {
    return {
      sourceAnchor: dx >= 0 ? 'right' : 'left',
      targetAnchor: dx >= 0 ? 'left' : 'right',
    };
  }
  return {
    sourceAnchor: dy >= 0 ? 'bottom' : 'top',
    targetAnchor: dy >= 0 ? 'top' : 'bottom',
  };
}
