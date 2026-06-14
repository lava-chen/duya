import type {
  AbsolutePositionResolver,
  AnchorId,
  CanvasElement,
  Direction,
  Point,
} from "../contracts.js";

export const GRID_PX = 80;

export const directionVector: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function anchorToDirection(anchorId: AnchorId): Direction | null {
  switch (anchorId) {
    case "top":
      return "up";
    case "bottom":
      return "down";
    case "left":
      return "left";
    case "right":
      return "right";
    case "center":
      return null;
  }
}

export function autoDirection(src: Point, tgt: Point): Direction {
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "down" : "up";
}

function getRectEdgeIntersection(
  rect: { x: number; y: number; w: number; h: number },
  from: Point,
  to: Point,
): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: rect.y + rect.h / 2 };
  }

  const dirX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const dirY = dy === 0 ? 0 : dy > 0 ? 1 : -1;

  const outsetRect = {
    x: rect.x - 4,
    y: rect.y - 4,
    w: rect.w + 8,
    h: rect.h + 8,
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

function resolveAbsolutePosition(
  node: CanvasElement,
  allNodes: CanvasElement[],
  resolver?: AbsolutePositionResolver,
): Point {
  if (resolver) {
    return resolver(node, allNodes);
  }

  return {
    x: node.position.x,
    y: node.position.y,
  };
}

export function getAnchorPosition(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
  resolver?: AbsolutePositionResolver,
): Point {
  const abs = resolveAbsolutePosition(node, allNodes, resolver);
  const pxW = node.position.w * GRID_PX;
  const pxH = node.position.h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;

  switch (anchorId) {
    case "top":
      return { x: cx, y: abs.y };
    case "bottom":
      return { x: cx, y: abs.y + pxH };
    case "left":
      return { x: abs.x, y: cy };
    case "right":
      return { x: abs.x + pxW, y: cy };
    case "center":
      return { x: cx, y: cy };
  }
}

export function getConnectorEndpoint(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
  otherPoint: Point,
  resolver?: AbsolutePositionResolver,
): Point {
  const abs = resolveAbsolutePosition(node, allNodes, resolver);
  const pxW = node.position.w * GRID_PX;
  const pxH = node.position.h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;

  if (anchorId !== "center") {
    return getAnchorPosition(node, anchorId, allNodes, resolver);
  }

  const anchorPos = { x: cx, y: cy };
  return getRectEdgeIntersection(
    { x: abs.x, y: abs.y, w: pxW, h: pxH },
    anchorPos,
    otherPoint,
  );
}

export function computeBezierPath(
  src: Point,
  srcDir: Direction,
  tgt: Point,
  tgtDir: Direction,
  curvature = 0.4,
): string {
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);
  const tension = Math.max(28, dist * curvature);
  const cp1 = {
    x: src.x + directionVector[srcDir].x * tension,
    y: src.y + directionVector[srcDir].y * tension,
  };
  const cp2 = {
    x: tgt.x + directionVector[tgtDir].x * tension,
    y: tgt.y + directionVector[tgtDir].y * tension,
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
  const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y);
  const tension = Math.max(28, dist * curvature);
  const cp1 = {
    x: src.x + directionVector[srcDir].x * tension,
    y: src.y + directionVector[srcDir].y * tension,
  };
  const cp2 = {
    x: tgt.x + directionVector[tgtDir].x * tension,
    y: tgt.y + directionVector[tgtDir].y * tension,
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

export function computeStraightPath(src: Point, tgt: Point): string {
  return `M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`;
}

export function autoSelectAnchor(
  cursorPos: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
  resolver?: AbsolutePositionResolver,
): AnchorId {
  const abs = resolveAbsolutePosition(node, allNodes, resolver);
  const pxW = node.position.w * GRID_PX;
  const pxH = node.position.h * GRID_PX;
  const cx = abs.x + pxW / 2;
  const cy = abs.y + pxH / 2;

  const anchors: { id: AnchorId; x: number; y: number }[] = [
    { id: "top", x: cx, y: abs.y },
    { id: "bottom", x: cx, y: abs.y + pxH },
    { id: "left", x: abs.x, y: cy },
    { id: "right", x: abs.x + pxW, y: cy },
    { id: "center", x: cx, y: cy },
  ];

  let minDist = Infinity;
  let best: AnchorId = "center";
  for (const a of anchors) {
    const d = Math.hypot(cursorPos.x - a.x, cursorPos.y - a.y);
    if (d < minDist) {
      minDist = d;
      best = a.id;
    }
  }
  return best;
}
