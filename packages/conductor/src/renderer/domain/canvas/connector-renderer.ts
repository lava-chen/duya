import type { CanvasElement } from '../../types/conductor';
import type { AnchorId, Point, Direction } from '../../types/canvas-node';
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

  switch (anchorId) {
    case 'top': return { x: cx, y: abs.y };
    case 'bottom': return { x: cx, y: abs.y + pxH };
    case 'left': return { x: abs.x, y: cy };
    case 'right': return { x: abs.x + pxW, y: cy };
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
    return getAnchorPosition(node, anchorId, allNodes);
  }

  const anchorPos = { x: cx, y: cy };
  const edge = getRectEdgeIntersection(
    { x: abs.x, y: abs.y, w: pxW, h: pxH },
    anchorPos,
    otherPoint,
  );
  return edge;
}

export function computeBezierPath(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  curvature = 0.4,
): string {
  // Defensive: ensure all coordinates are finite and directions are valid.
  if (!Number.isFinite(src.x) || !Number.isFinite(src.y) ||
      !Number.isFinite(tgt.x) || !Number.isFinite(tgt.y)) {
    return '';
  }
  const safeSrcDir = directionVector[srcDir] ? srcDir : autoDirection(src, tgt);
  const safeTgtDir = directionVector[tgtDir] ? tgtDir : autoDirection(tgt, src);
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);
  const tension = Math.max(28, dist * curvature);
  const cp1 = {
    x: src.x + directionVector[safeSrcDir].x * tension,
    y: src.y + directionVector[safeSrcDir].y * tension,
  };
  const cp2 = {
    x: tgt.x + directionVector[safeTgtDir].x * tension,
    y: tgt.y + directionVector[safeTgtDir].y * tension,
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
): Point {
  // Defensive: ensure all coordinates are finite and directions are valid.
  if (!Number.isFinite(src.x) || !Number.isFinite(src.y) ||
      !Number.isFinite(tgt.x) || !Number.isFinite(tgt.y)) {
    return { x: 0, y: 0 };
  }
  const safeSrcDir = directionVector[srcDir] ? srcDir : autoDirection(src, tgt);
  const safeTgtDir = directionVector[tgtDir] ? tgtDir : autoDirection(tgt, src);
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);
  const tension = Math.max(28, dist * curvature);
  const cp1 = {
    x: src.x + directionVector[safeSrcDir].x * tension,
    y: src.y + directionVector[safeSrcDir].y * tension,
  };
  const cp2 = {
    x: tgt.x + directionVector[safeTgtDir].x * tension,
    y: tgt.y + directionVector[safeTgtDir].y * tension,
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

export function autoSelectAnchor(
  cursorPos: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
): AnchorId {
  const gridAbs = getAbsolutePosition(node, allNodes);
  const abs = { x: gridAbs.x * GRID_PX, y: gridAbs.y * GRID_PX };
  const pxW = node.position.w * GRID_PX;
  const pxH = node.position.h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;

  const anchors: { id: AnchorId; x: number; y: number }[] = [
    { id: 'top', x: cx, y: abs.y },
    { id: 'bottom', x: cx, y: abs.y + pxH },
    { id: 'left', x: abs.x, y: cy },
    { id: 'right', x: abs.x + pxW, y: cy },
    { id: 'center', x: cx, y: cy },
  ];

  let minDist = Infinity;
  let best: AnchorId = 'center';
  for (const a of anchors) {
    const d = Math.hypot(cursorPos.x - a.x, cursorPos.y - a.y);
    if (d < minDist) {
      minDist = d;
      best = a.id;
    }
  }
  return best;
}
