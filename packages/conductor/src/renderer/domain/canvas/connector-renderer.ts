import type { CanvasElement } from '../../types/conductor';
import type {
  AnchorId,
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

export type OrthogonalSegmentOrientation = 'horizontal' | 'vertical';

export interface ElbowSegmentSnapResult {
  coordinate: number;
  snapped: boolean;
}

export interface ConnectorArrowGeometry {
  left: Point;
  right: Point;
}

export function getConnectorArrowGeometry(
  tip: Point,
  center: Point,
  headLength = 9,
  halfWidth = 4.6,
): ConnectorArrowGeometry {
  const dx = center.x - tip.x;
  const dy = center.y - tip.y;
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

function orthogonalizePoints(points: Point[]): Point[] {
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
): Point[] {
  const savedWaypoints = waypoints?.filter(isFinitePoint).map((point) => ({ ...point })) ?? [];
  if (savedWaypoints.length > 0) {
    const first = savedWaypoints[0];
    const last = savedWaypoints[savedWaypoints.length - 1];
    if (srcDir === 'left' || srcDir === 'right') first.y = src.y;
    else first.x = src.x;
    if (tgtDir === 'left' || tgtDir === 'right') last.y = tgt.y;
    else last.x = tgt.x;
    return orthogonalizePoints([src, ...savedWaypoints, tgt]);
  }

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

  if (srcHorizontal && tgtHorizontal) {
    const midX = (srcStub.x + tgtStub.x) / 2;
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
    const midY = (srcStub.y + tgtStub.y) / 2;
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
    ? { x: tgtStub.x, y: srcStub.y }
    : { x: srcStub.x, y: tgtStub.y };
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
