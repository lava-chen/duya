"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "../..//types/conductor";
import type {
  AnchorId,
  ConnectorEndpoint,
  ConnectorMarker,
  ConnectorRoutingMode,
  CurveControlOffsets,
  Point,
} from "../..//types/canvas-node";
import { useConductorStore } from "../..//stores/conductor-store";
import {
  anchorToDirection,
  autoDirection,
  computeBezierPath,
  computeElbowRoutePoints,
  computeRoundedElbowPath,
  evaluateBezierPoint,
  GRID_PX,
  getAnchorPosition,
  getBezierControlPoints,
  getConnectorEndpoint,
  getConnectorArrowGeometry,
  getPolylineMidpoint,
  orthogonalizeElbowPoints,
  snapConnectorEdgePosition,
  simplifyOrthogonalPoints,
} from "../..//domain/canvas/connector-renderer";

const HIT_TARGET_WIDTH = 20;
const DEFAULT_CONNECTOR_COLOR = "var(--text-secondary)";
const ELBOW_STUB_LENGTH = 40;
const ELBOW_CLEARANCE = 28;

interface ObstacleBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function getConnectorObstacles(
  elements: CanvasElement[],
  sourceId: string,
  targetId: string,
): ObstacleBounds[] {
  return elements
    .filter((element) =>
      element.id !== sourceId &&
      element.id !== targetId &&
      !element.elementKind.startsWith("native/connector") &&
      !element.elementKind.startsWith("native/group"),
    )
    .map((element) => ({
      left: element.position.x * GRID_PX - ELBOW_CLEARANCE,
      top: element.position.y * GRID_PX - ELBOW_CLEARANCE,
      right: (element.position.x + element.position.w) * GRID_PX + ELBOW_CLEARANCE,
      bottom: (element.position.y + element.position.h) * GRID_PX + ELBOW_CLEARANCE,
    }));
}

function routeIntersectsObstacle(points: Point[], obstacle: ObstacleBounds): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (Math.abs(start.y - end.y) < 0.01) {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      if (start.y > obstacle.top && start.y < obstacle.bottom && right > obstacle.left && left < obstacle.right) return true;
    } else if (Math.abs(start.x - end.x) < 0.01) {
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      if (start.x > obstacle.left && start.x < obstacle.right && bottom > obstacle.top && top < obstacle.bottom) return true;
    }
  }
  return false;
}

function routeLength(points: Point[]): number {
  return points.slice(0, -1).reduce((length, point, index) =>
    length + Math.hypot(points[index + 1].x - point.x, points[index + 1].y - point.y), 0);
}

type ConnectorDirection = NonNullable<ReturnType<typeof anchorToDirection>>;

function getElbowStub(point: Point, direction: ConnectorDirection): Point {
  switch (direction) {
    case "left":
      return { x: point.x - ELBOW_STUB_LENGTH, y: point.y };
    case "right":
      return { x: point.x + ELBOW_STUB_LENGTH, y: point.y };
    case "up":
      return { x: point.x, y: point.y - ELBOW_STUB_LENGTH };
    case "down":
      return { x: point.x, y: point.y + ELBOW_STUB_LENGTH };
  }
}

function computePerpendicularDetour(
  src: Point,
  srcDir: ConnectorDirection,
  tgt: Point,
  tgtDir: ConnectorDirection,
  lane: number,
): Point[] {
  const srcStub = getElbowStub(src, srcDir);
  const tgtStub = getElbowStub(tgt, tgtDir);
  const sourceHorizontal = srcDir === "left" || srcDir === "right";
  return simplifyOrthogonalPoints(sourceHorizontal
    ? [src, srcStub, { x: srcStub.x, y: lane }, { x: tgtStub.x, y: lane }, tgtStub, tgt]
    : [src, srcStub, { x: lane, y: srcStub.y }, { x: lane, y: tgtStub.y }, tgtStub, tgt]);
}

function chooseElbowRoute(
  src: Point,
  srcDir: ReturnType<typeof anchorToDirection>,
  tgt: Point,
  tgtDir: ReturnType<typeof anchorToDirection>,
  waypoints: Point[] | undefined,
  obstacles: ObstacleBounds[],
): Point[] {
  const resolvedSrcDir = srcDir ?? autoDirection(src, tgt);
  const resolvedTgtDir = tgtDir ?? autoDirection(tgt, src);
  const fallback = computeElbowRoutePoints(src, resolvedSrcDir, tgt, resolvedTgtDir, waypoints, ELBOW_STUB_LENGTH);
  if (waypoints?.length || obstacles.length === 0) return fallback;

  const sourceHorizontal = resolvedSrcDir === "left" || resolvedSrcDir === "right";
  const targetHorizontal = resolvedTgtDir === "left" || resolvedTgtDir === "right";
  if (sourceHorizontal !== targetHorizontal) return fallback;
  if (!obstacles.some((obstacle) => routeIntersectsObstacle(fallback, obstacle))) return fallback;

  const endpointsAreAligned = sourceHorizontal
    ? Math.abs(src.y - tgt.y) < 0.01
    : Math.abs(src.x - tgt.x) < 0.01;
  const laneCandidates = sourceHorizontal
    ? obstacles.flatMap((obstacle) => endpointsAreAligned ? [obstacle.top, obstacle.bottom] : [obstacle.left, obstacle.right])
    : obstacles.flatMap((obstacle) => endpointsAreAligned ? [obstacle.left, obstacle.right] : [obstacle.top, obstacle.bottom]);
  const candidates = laneCandidates
    .map((lane) => endpointsAreAligned
      ? computePerpendicularDetour(src, resolvedSrcDir, tgt, resolvedTgtDir, lane)
      : computeElbowRoutePoints(src, resolvedSrcDir, tgt, resolvedTgtDir, undefined, ELBOW_STUB_LENGTH, lane))
    .filter((route) => !obstacles.some((obstacle) => routeIntersectsObstacle(route, obstacle)));

  if (candidates.length === 0) return fallback;
  return candidates.reduce((best, candidate) => routeLength(candidate) < routeLength(best) ? candidate : best);
}

export interface ConnectorComputedData {
  path: string;
  srcPoint: Point;
  tgtPoint: Point;
  sourceCenter: Point;
  targetCenter: Point;
  midPoint: Point;
  routingMode: ConnectorRoutingMode;
  sourceControl?: Point;
  targetControl?: Point;
  elbowPoints?: Point[];
}

interface ConnectorPathProps {
  connector: CanvasElement;
  elements: CanvasElement[];
  isSelected: boolean;
  layer?: "all" | "visual" | "controls";
  isHovered?: boolean;
  onClick?: (connectorId: string) => void;
  onHover?: (connectorId: string | null) => void;
  onEndpointPointerDown?: (
    connectorId: string,
    endpoint: "source" | "target",
    point: Point,
    event: React.PointerEvent<SVGCircleElement>
  ) => void;
  onCurveControlPointerDown?: (
    connectorId: string,
    control: "source" | "target",
    point: Point,
    event: React.PointerEvent<SVGCircleElement>
  ) => void;
  onElbowSegmentPointerDown?: (
    connectorId: string,
    segmentIndex: number,
    orientation: "horizontal" | "vertical",
    event: React.PointerEvent<SVGRectElement>
  ) => void;
}

export function resolveConnectorRoutingMode(config: Record<string, unknown>): ConnectorRoutingMode {
  // Connectors created before routingMode existed are diagram connectors too.
  // Keep curves opt-in so persisted canvases do not silently become diagonal.
  return config.routingMode === "curve" ? "curve" : "elbow";
}

export function resolveConnectorMarkers(config: Record<string, unknown>): {
  startMarker: ConnectorMarker;
  endMarker: ConnectorMarker;
} {
  const legacyStyle = config.style as Record<string, unknown> | undefined;
  const explicitStart = config.startMarker as ConnectorMarker | undefined;
  const explicitEnd = config.endMarker as ConnectorMarker | undefined;
  const legacyStart = config.arrowStart === true ? "arrow" : "none";
  const legacyEndEnabled = (config.arrowEnd as boolean | undefined) ?? legacyStyle?.endMarker !== "none";
  return {
    startMarker: explicitStart ?? legacyStart,
    endMarker: explicitEnd ?? (legacyEndEnabled ? "arrow" : "none"),
  };
}

function resolveEffectiveAnchor(
  connector: CanvasElement,
  endpointRole: "source" | "target",
  elements: CanvasElement[],
): Exclude<AnchorId, "center"> {
  const endpoint = connector.config[endpointRole] as ConnectorEndpoint | undefined;
  if (endpoint?.anchorId && endpoint.anchorId !== "center") return endpoint.anchorId;
  const otherRole = endpointRole === "source" ? "target" : "source";
  const otherEndpoint = connector.config[otherRole] as ConnectorEndpoint | undefined;
  const node = endpoint ? elements.find((element) => element.id === endpoint.nodeId) : null;
  const otherNode = otherEndpoint ? elements.find((element) => element.id === otherEndpoint.nodeId) : null;
  if (!node || !otherNode) return "right";
  const center = getAnchorPosition(node, "center", elements);
  const otherCenter = getAnchorPosition(otherNode, "center", elements);
  const halfWidth = Math.max(1, node.position.w * GRID_PX / 2);
  const halfHeight = Math.max(1, node.position.h * GRID_PX / 2);
  const otherHalfWidth = Math.max(1, otherNode.position.w * GRID_PX / 2);
  const otherHalfHeight = Math.max(1, otherNode.position.h * GRID_PX / 2);
  const deltaX = otherCenter.x - center.x;
  const deltaY = otherCenter.y - center.y;

  // Diagram layers may be much farther apart horizontally than vertically
  // (a parent with several children). When their bounds are vertically
  // separated, bottom-to-top is the natural attachment and preserves a
  // shared vertical trunk before the horizontal branch.
  const verticalGap = Math.abs(deltaY) - halfHeight - otherHalfHeight;
  if (verticalGap >= 24) return deltaY >= 0 ? "bottom" : "top";

  const horizontalGap = Math.abs(deltaX) - halfWidth - otherHalfWidth;
  if (horizontalGap >= 24) return deltaX >= 0 ? "right" : "left";

  const normalizedX = deltaX / halfWidth;
  const normalizedY = deltaY / halfHeight;
  if (Math.abs(normalizedX) >= Math.abs(normalizedY)) {
    return normalizedX >= 0 ? "right" : "left";
  }
  return normalizedY >= 0 ? "bottom" : "top";
}

function resolveAutoAttachment(
  connector: CanvasElement,
  endpointRole: "source" | "target",
  elements: CanvasElement[],
): { anchorId: Exclude<AnchorId, "center">; edgePosition: number } | null {
  const endpoint = connector.config[endpointRole] as ConnectorEndpoint | undefined;
  if (!endpoint) return null;
  const anchorId = resolveEffectiveAnchor(connector, endpointRole, elements);
  const explicitPosition = Number.isFinite(endpoint.edgePosition)
    ? Math.max(0, Math.min(1, endpoint.edgePosition as number))
    : null;

  // Outgoing connections leave a node through the centre of their resolved
  // side. Nearby explicit ports are clustered as well, so separately drawn
  // elbows can converge into one shared trunk without overriding deliberate
  // ports that are visibly far apart.
  if (endpointRole === "source") {
    const position = explicitPosition ?? 0.5;
    if (resolveConnectorRoutingMode(connector.config) !== "elbow") {
      return { anchorId, edgePosition: position };
    }
    const node = elements.find((element) => element.id === endpoint.nodeId);
    const edgeLengthPx = node
      ? (anchorId === "top" || anchorId === "bottom" ? node.position.w : node.position.h) * GRID_PX
      : GRID_PX * 3;
    const peerPositions = elements.flatMap((candidate) => {
      if (candidate.elementKind !== "native/connector" || resolveConnectorRoutingMode(candidate.config) !== "elbow") return [];
      const candidateEndpoint = candidate.config.source as ConnectorEndpoint | undefined;
      if (!candidateEndpoint || candidateEndpoint.nodeId !== endpoint.nodeId) return [];
      if (resolveEffectiveAnchor(candidate, "source", elements) !== anchorId) return [];
      return [Number.isFinite(candidateEndpoint.edgePosition)
        ? Math.max(0, Math.min(1, candidateEndpoint.edgePosition as number))
        : 0.5];
    });
    return {
      anchorId,
      edgePosition: snapConnectorEdgePosition(position, peerPositions, edgeLengthPx),
    };
  }

  if (explicitPosition !== null) return { anchorId, edgePosition: explicitPosition };

  const peers: Array<{ connectorId: string; endpointRole: "source" | "target" }> = [];
  for (const candidate of elements) {
    if (candidate.elementKind !== "native/connector") continue;
    for (const role of ["source", "target"] as const) {
      const candidateEndpoint = candidate.config[role] as ConnectorEndpoint | undefined;
      if (!candidateEndpoint || candidateEndpoint.nodeId !== endpoint.nodeId || Number.isFinite(candidateEndpoint.edgePosition)) continue;
      if (resolveEffectiveAnchor(candidate, role, elements) === anchorId) {
        peers.push({ connectorId: candidate.id, endpointRole: role });
      }
    }
  }
  peers.sort((a, b) => `${a.connectorId}:${a.endpointRole}`.localeCompare(`${b.connectorId}:${b.endpointRole}`));
  const index = Math.max(0, peers.findIndex((peer) => peer.connectorId === connector.id && peer.endpointRole === endpointRole));
  const edgePosition = peers.length <= 1 ? 0.5 : 0.18 + (index * 0.64) / (peers.length - 1);
  return { anchorId, edgePosition };
}

export function getComputedConnectorData(
  connector: CanvasElement,
  elements: CanvasElement[],
  sourcePos: CanvasElement["position"] | null,
  targetPos: CanvasElement["position"] | null
): ConnectorComputedData | null {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  if (!sourceEndpoint || !targetEndpoint || !sourcePos || !targetPos) return null;

  const sourceNode = elements.find((element) => element.id === sourceEndpoint.nodeId);
  const targetNode = elements.find((element) => element.id === targetEndpoint.nodeId);
  if (!sourceNode || !targetNode) return null;

  const sourceAttachment = resolveAutoAttachment(connector, "source", elements);
  const targetAttachment = resolveAutoAttachment(connector, "target", elements);
  if (!sourceAttachment || !targetAttachment) return null;
  const srcAnchor = sourceAttachment.anchorId;
  const tgtAnchor = targetAttachment.anchorId;
  const sourceCenter = getAnchorPosition(sourceNode, "center", elements);
  const targetCenter = getAnchorPosition(targetNode, "center", elements);
  const rawSrcPoint = getAnchorPosition(sourceNode, srcAnchor, elements, sourceAttachment.edgePosition);
  const rawTgtPoint = getAnchorPosition(targetNode, tgtAnchor, elements, targetAttachment.edgePosition);
  const srcPoint = getConnectorEndpoint(sourceNode, srcAnchor, elements, rawTgtPoint, sourceAttachment.edgePosition);
  const tgtPoint = getConnectorEndpoint(targetNode, tgtAnchor, elements, rawSrcPoint, targetAttachment.edgePosition);
  const srcDir = anchorToDirection(srcAnchor) || autoDirection(srcPoint, tgtPoint);
  const tgtDir = anchorToDirection(tgtAnchor) || autoDirection(tgtPoint, srcPoint);
  const routingMode = resolveConnectorRoutingMode(connector.config);

  if (routingMode === "elbow") {
    const waypoints = Array.isArray(connector.config.waypoints)
      ? connector.config.waypoints as Point[]
      : undefined;
    const obstacles = getConnectorObstacles(elements, sourceNode.id, targetNode.id);
    // Guard the render boundary as well as the route builder. Persisted
    // waypoints and future routing strategies must never be able to turn an
    // elbow connector into a diagonal segment.
    const points = orthogonalizeElbowPoints(
      chooseElbowRoute(srcPoint, srcDir, tgtPoint, tgtDir, waypoints, obstacles),
    );
    return {
      path: computeRoundedElbowPath(points, Number(connector.config.cornerRadius ?? 12)),
      srcPoint,
      tgtPoint,
      sourceCenter,
      targetCenter,
      midPoint: getPolylineMidpoint(points),
      routingMode,
      elbowPoints: points,
    };
  }

  const curvature = Number(connector.config.curvature ?? 0.4);
  const offsets = connector.config.curveControlOffsets as CurveControlOffsets | undefined;
  const constrainControl = (offset: Point, endpoint: Point, center: Point): Point => {
    const dx = endpoint.x - center.x;
    const dy = endpoint.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    const outward = { x: dx / length, y: dy / length };
    const tension = Math.max(24, offset.x * outward.x + offset.y * outward.y);
    return { x: outward.x * tension, y: outward.y * tension };
  };
  const constrainedOffsets = offsets
    ? {
        source: constrainControl(offsets.source, srcPoint, sourceCenter),
        target: constrainControl(offsets.target, tgtPoint, targetCenter),
      }
    : undefined;
  const controls = getBezierControlPoints(srcPoint, srcDir, tgtPoint, tgtDir, curvature, constrainedOffsets);
  return {
    path: computeBezierPath(srcPoint, srcDir, tgtPoint, tgtDir, curvature, constrainedOffsets),
    srcPoint,
    tgtPoint,
    sourceCenter,
    targetCenter,
    midPoint: evaluateBezierPoint(srcPoint, srcDir, tgtPoint, tgtDir, curvature, 0.5, constrainedOffsets),
    routingMode,
    sourceControl: controls.source,
    targetControl: controls.target,
  };
}

function ConnectorMarkerDefs({ prefix, color }: { prefix: string; color: string }) {
  return (
    <defs>
      <marker id={`${prefix}-circle`} markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">
        <circle cx="5" cy="5" r="3.5" fill="var(--canvas-bg)" stroke={color} strokeWidth="1.8" />
      </marker>
      <marker id={`${prefix}-diamond`} markerWidth="11" markerHeight="11" refX="5.5" refY="5.5" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">
        <path d="M 5.5 0.8 L 10.2 5.5 L 5.5 10.2 L 0.8 5.5 Z" fill="var(--canvas-bg)" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      </marker>
      <marker id={`${prefix}-bar`} markerWidth="7" markerHeight="11" refX="3.5" refY="5.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse" overflow="visible">
        <path d="M 3.5 0.8 L 3.5 10.2" stroke={color} strokeWidth="2" strokeLinecap="round" />
      </marker>
    </defs>
  );
}

function markerUrl(prefix: string, marker: ConnectorMarker): string | undefined {
  return marker === "none" || marker === "arrow" || marker === "open-arrow"
    ? undefined
    : `url(#${prefix}-${marker})`;
}

function ConnectorArrow({
  marker,
  tip,
  directionPoint,
  color,
  testId,
}: {
  marker: ConnectorMarker;
  tip: Point;
  directionPoint: Point;
  color: string;
  testId: string;
}) {
  if (marker !== "arrow" && marker !== "open-arrow") return null;
  const { left, right } = getConnectorArrowGeometry(tip, directionPoint);
  if (marker === "open-arrow") {
    return (
      <path
        data-testid={testId}
        d={`M ${left.x} ${left.y} L ${tip.x} ${tip.y} L ${right.x} ${right.y}`}
        fill="none"
        stroke={color}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: "none" }}
      />
    );
  }
  return (
    <path
      data-testid={testId}
      d={`M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`}
      fill={color}
      stroke={color}
      strokeWidth={0.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ pointerEvents: "none" }}
    />
  );
}

export const ConnectorPath: React.FC<ConnectorPathProps> = ({
  connector,
  elements,
  isSelected,
  layer = "all",
  isHovered = false,
  onClick,
  onHover,
  onEndpointPointerDown,
  onCurveControlPointerDown,
  onElbowSegmentPointerDown,
}) => {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  const legacyStyle = connector.config.style as Record<string, unknown> | undefined;
  const stroke = (connector.config.color as string) || (legacyStyle?.stroke as string) || DEFAULT_CONNECTOR_COLOR;
  const strokeWidth = 3.5;
  const strokeStyle = (connector.config.strokeStyle as "solid" | "dashed" | "dotted" | undefined) || "solid";
  const dashArray = strokeStyle === "dashed" ? "10 7" : strokeStyle === "dotted" ? "1 7" : undefined;
  const renderStroke = isSelected ? "var(--conductor-accent)" : stroke;
  const { startMarker, endMarker } = resolveConnectorMarkers(connector.config);
  const markerPrefix = `connector-marker-${connector.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const label = typeof connector.config.label === "string" ? connector.config.label.trim() : "";
  const renderVisuals = layer === "all" || layer === "visual";
  const renderControls = layer === "all" || layer === "controls";

  const sourceNodeId = sourceEndpoint?.nodeId;
  const targetNodeId = targetEndpoint?.nodeId;
  const sourcePos = useConductorStore((state) => {
    const element = sourceNodeId ? state.elements.find((candidate) => candidate.id === sourceNodeId) : null;
    return element?.position ?? null;
  });
  const targetPos = useConductorStore((state) => {
    const element = targetNodeId ? state.elements.find((candidate) => candidate.id === targetNodeId) : null;
    return element?.position ?? null;
  });
  const computedData = useMemo(
    () => getComputedConnectorData(connector, elements, sourcePos, targetPos),
    [connector, elements, sourcePos, targetPos]
  );

  if (!computedData || !computedData.path || computedData.path.includes("NaN")) return null;
  const sourceAdjacent = computedData.routingMode === "elbow"
    ? computedData.elbowPoints?.[1]
    : computedData.sourceControl;
  const targetAdjacent = computedData.routingMode === "elbow"
    ? computedData.elbowPoints?.[Math.max(0, (computedData.elbowPoints?.length ?? 1) - 2)]
    : computedData.targetControl;
  const sourceArrowDirectionPoint = sourceAdjacent
    ? { x: computedData.srcPoint.x * 2 - sourceAdjacent.x, y: computedData.srcPoint.y * 2 - sourceAdjacent.y }
    : computedData.sourceCenter;
  const targetArrowDirectionPoint = targetAdjacent
    ? { x: computedData.tgtPoint.x * 2 - targetAdjacent.x, y: computedData.tgtPoint.y * 2 - targetAdjacent.y }
    : computedData.targetCenter;
  const labelWidth = Math.max(48, Math.min(220, label.length * 7.4 + 20));
  const elbowHandles = computedData.elbowPoints?.slice(0, -1).flatMap((point, segmentIndex) => {
    const next = computedData.elbowPoints?.[segmentIndex + 1];
    if (!next || segmentIndex === 0 || segmentIndex >= (computedData.elbowPoints?.length ?? 0) - 2) return [];
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    if (length < 28) return [];
    return [{
      segmentIndex,
      orientation: Math.abs(next.x - point.x) >= Math.abs(next.y - point.y)
        ? "horizontal" as const
        : "vertical" as const,
      point: { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 },
    }];
  }) ?? [];

  return (
    <g
      style={{ cursor: renderVisuals ? "pointer" : "default" }}
      onPointerEnter={renderVisuals ? () => onHover?.(connector.id) : undefined}
      onPointerLeave={renderVisuals ? () => onHover?.(null) : undefined}
      onClick={renderVisuals ? (event) => {
        event.stopPropagation();
        onClick?.(connector.id);
      } : undefined}
    >
      {renderVisuals && <ConnectorMarkerDefs prefix={markerPrefix} color={renderStroke} />}
      {renderVisuals && (isHovered || isSelected) && (
        <path d={computedData.path} fill="none" stroke="var(--conductor-accent)" strokeWidth={strokeWidth + (isSelected ? 7 : 5)} strokeLinecap="round" strokeLinejoin="round" opacity={isSelected ? 0.16 : 0.09} style={{ pointerEvents: "none" }} />
      )}
      {renderVisuals && <path d={computedData.path} fill="none" stroke="transparent" strokeWidth={HIT_TARGET_WIDTH} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "auto" }} />}
      {renderVisuals && <path
        d={computedData.path}
        fill="none"
        stroke={renderStroke}
        strokeWidth={isSelected ? strokeWidth + 0.35 : strokeWidth}
        strokeLinecap={startMarker === "arrow" || startMarker === "open-arrow" || endMarker === "arrow" || endMarker === "open-arrow" ? "butt" : "round"}
        strokeLinejoin="round"
        strokeDasharray={dashArray}
        markerStart={markerUrl(markerPrefix, startMarker)}
        markerEnd={markerUrl(markerPrefix, endMarker)}
        style={{ pointerEvents: "none", transition: "stroke var(--motion-duration-micro) var(--motion-smooth), stroke-width var(--motion-duration-micro) var(--motion-smooth)" }}
      />}
      {renderVisuals && <ConnectorArrow marker={startMarker} tip={computedData.srcPoint} directionPoint={sourceArrowDirectionPoint} color={renderStroke} testId="connector-start-arrow" />}
      {renderVisuals && <ConnectorArrow marker={endMarker} tip={computedData.tgtPoint} directionPoint={targetArrowDirectionPoint} color={renderStroke} testId="connector-end-arrow" />}

      {renderVisuals && label && (
        <g transform={`translate(${computedData.midPoint.x}, ${computedData.midPoint.y})`} style={{ pointerEvents: "none" }}>
          <rect x={-labelWidth / 2} y={-13} width={labelWidth} height={26} rx={6} fill="var(--canvas-bg)" stroke={isSelected ? "var(--conductor-accent)" : "var(--conductor-border)"} strokeWidth={1} />
          <text x={0} y={0.5} textAnchor="middle" dominantBaseline="middle" fill="var(--text-primary)" fontSize={12.5} fontWeight={500}>{label}</text>
        </g>
      )}

      {renderControls && isSelected && computedData.routingMode === "curve" && computedData.sourceControl && computedData.targetControl && (
        <>
          <path d={`M ${computedData.srcPoint.x} ${computedData.srcPoint.y} L ${computedData.sourceControl.x} ${computedData.sourceControl.y}`} stroke="var(--conductor-accent)" strokeWidth={1.4} strokeDasharray="5 5" opacity={0.65} />
          <path d={`M ${computedData.tgtPoint.x} ${computedData.tgtPoint.y} L ${computedData.targetControl.x} ${computedData.targetControl.y}`} stroke="var(--conductor-accent)" strokeWidth={1.4} strokeDasharray="5 5" opacity={0.65} />
          {(["source", "target"] as const).map((control) => {
            const point = control === "source" ? computedData.sourceControl : computedData.targetControl;
            if (!point) return null;
            return <circle key={control} cx={point.x} cy={point.y} r={5} fill="var(--canvas-bg)" stroke="var(--conductor-accent)" strokeWidth={2} style={{ cursor: "move", pointerEvents: "auto" }} onPointerDown={(event) => onCurveControlPointerDown?.(connector.id, control, point, event)} />;
          })}
        </>
      )}

      {renderControls && isSelected && computedData.routingMode === "elbow" && elbowHandles.map((handle) => (
        <rect
          key={`${handle.segmentIndex}-${handle.orientation}`}
          x={handle.point.x - (handle.orientation === "horizontal" ? 7 : 3.5)}
          y={handle.point.y - (handle.orientation === "horizontal" ? 3.5 : 7)}
          width={handle.orientation === "horizontal" ? 14 : 7}
          height={handle.orientation === "horizontal" ? 7 : 14}
          rx={2.5}
          fill="var(--canvas-bg)"
          stroke="var(--conductor-accent)"
          strokeWidth={1.8}
          style={{ cursor: handle.orientation === "horizontal" ? "ns-resize" : "ew-resize", pointerEvents: "auto" }}
          onPointerDown={(event) => onElbowSegmentPointerDown?.(connector.id, handle.segmentIndex, handle.orientation, event)}
        />
      ))}

      {renderControls && isSelected && (["source", "target"] as const).map((endpoint) => {
        const point = endpoint === "source" ? computedData.srcPoint : computedData.tgtPoint;
        const center = endpoint === "source" ? computedData.sourceCenter : computedData.targetCenter;
        return (
          <g key={endpoint}>
            <path d={`M ${center.x} ${center.y} L ${point.x} ${point.y}`} stroke="var(--conductor-accent)" strokeWidth={1.4} strokeDasharray="5 5" opacity={0.65} style={{ pointerEvents: "none" }} />
            <circle cx={point.x} cy={point.y} r={6} fill="var(--canvas-bg)" stroke="var(--conductor-accent)" strokeWidth={2} style={{ cursor: "grab", pointerEvents: "auto" }} onPointerDown={(event) => onEndpointPointerDown?.(connector.id, endpoint, point, event)} />
          </g>
        );
      })}
    </g>
  );
};

interface ConnectorElementProps {
  element: CanvasElement;
}

export const ConnectorElement: React.FC<ConnectorElementProps> = ({ element }) => {
  const elements = useConductorStore((state) => state.elements);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none", zIndex: 0 }}>
      <ConnectorPath connector={element} elements={elements} isSelected={selectedElementId === element.id} />
    </svg>
  );
};
