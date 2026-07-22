"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "../..//types/conductor";
import type {
  ConnectorEndpoint,
  ConnectorMarker,
  ConnectorRoutingMode,
  CurveControlOffsets,
  Direction,
  Point,
} from "../..//types/canvas-node";
import { useConductorStore } from "../..//stores/conductor-store";
import {
  anchorToDirection,
  autoDirection,
  computeClippedConnectorCurve,
  computeConnectorCurveGeometry,
  computeConnectorCurvePath,
  computeElbowRoutePoints,
  computeRoundedElbowPath,
  evaluateConnectorCurvePoint,
  getConnectorEndpointNodeId,
  getConnectorEndpointRect,
  GRID_PX,
  getConnectorArrowGeometry,
  getPolylineMidpoint,
  orthogonalizeElbowPoints,
  resolveConnectorEndpoint,
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
  sourceReference: Point;
  targetReference: Point;
  sourceDirection: Direction;
  targetDirection: Direction;
  midPoint: Point;
  routingMode: ConnectorRoutingMode;
  sourceControl?: Point;
  targetControl?: Point;
  curveGeometry?: import("../..//domain/canvas/connector-renderer").ConnectorCurveGeometry;
  curveStartT?: number;
  curveEndT?: number;
  curveActivated?: boolean;
  sourceArrowDirectionPoint?: Point;
  targetArrowDirectionPoint?: Point;
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
    control: "midpoint" | "source" | "target",
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

export function getComputedConnectorData(
  connector: CanvasElement,
  elements: CanvasElement[],
  _sourcePos: CanvasElement["position"] | null = null,
  _targetPos: CanvasElement["position"] | null = null
): ConnectorComputedData | null {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  if (!sourceEndpoint || !targetEndpoint) return null;

  const sourceHint = resolveConnectorEndpoint(sourceEndpoint, elements)?.referencePoint;
  const targetHint = resolveConnectorEndpoint(targetEndpoint, elements)?.referencePoint;
  const sourceResolved = resolveConnectorEndpoint(sourceEndpoint, elements, targetHint);
  const targetResolved = resolveConnectorEndpoint(targetEndpoint, elements, sourceHint);
  if (!sourceResolved || !targetResolved) return null;

  const routingMode = resolveConnectorRoutingMode(connector.config);
  if (routingMode === "curve") {
    const sourceReference = sourceResolved.referencePoint;
    const targetReference = targetResolved.referencePoint;
    const midpointOffset = connector.config.curveMidpointOffset as Point | undefined;
    const controlOffsets = connector.config.curveControlOffsets as CurveControlOffsets | undefined;
    const geometry = computeConnectorCurveGeometry(
      sourceReference,
      targetReference,
      midpointOffset,
      controlOffsets,
    );
    const clipped = computeClippedConnectorCurve(
      geometry,
      getConnectorEndpointRect(sourceEndpoint, elements),
      getConnectorEndpointRect(targetEndpoint, elements),
    );
    return {
      path: clipped.path,
      srcPoint: clipped.sourcePoint,
      tgtPoint: clipped.targetPoint,
      sourceCenter: sourceReference,
      targetCenter: targetReference,
      sourceReference,
      targetReference,
      sourceDirection: sourceResolved.direction,
      targetDirection: targetResolved.direction,
      midPoint: geometry.midpoint,
      routingMode,
      sourceControl: geometry.sourceControl,
      targetControl: geometry.targetControl,
      curveGeometry: geometry,
      curveStartT: clipped.sourceT,
      curveEndT: clipped.targetT,
      curveActivated: geometry.activated,
      sourceArrowDirectionPoint: clipped.sourceArrowDirectionPoint,
      targetArrowDirectionPoint: clipped.targetArrowDirectionPoint,
    };
  }

  const srcPoint = sourceResolved.edgePoint;
  const tgtPoint = targetResolved.edgePoint;
  const sourceCenter = sourceResolved.referencePoint;
  const targetCenter = targetResolved.referencePoint;
  const srcDir = sourceResolved.direction;
  const tgtDir = targetResolved.direction;
  if (routingMode === "elbow") {
    const waypoints = Array.isArray(connector.config.waypoints)
      ? connector.config.waypoints as Point[]
      : undefined;
    const obstacles = getConnectorObstacles(
      elements,
      sourceResolved.nodeId ?? "",
      targetResolved.nodeId ?? "",
    );
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
      sourceReference: sourceResolved.referencePoint,
      targetReference: targetResolved.referencePoint,
      sourceDirection: srcDir,
      targetDirection: tgtDir,
      midPoint: getPolylineMidpoint(points),
      routingMode,
      elbowPoints: points,
    };
  }

  return null;
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

function isArrowMarker(marker: ConnectorMarker): boolean {
  return marker === "arrow" || marker === "open-arrow";
}

function getArrowBasePoint(tip: Point, directionPoint: Point): Point {
  const { left, right } = getConnectorArrowGeometry(tip, directionPoint);
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

function getTrimmedConnectorPath(
  data: ConnectorComputedData,
  sourceLineEnd: Point | undefined,
  targetLineEnd: Point | undefined,
  cornerRadius: number,
): string {
  if (!sourceLineEnd && !targetLineEnd) return data.path;

  const start = sourceLineEnd ?? data.srcPoint;
  const end = targetLineEnd ?? data.tgtPoint;

  if (data.routingMode === "elbow" && data.elbowPoints) {
    const points = [...data.elbowPoints];
    points[0] = start;
    points[points.length - 1] = end;
    return computeRoundedElbowPath(points, cornerRadius);
  }

  if (data.routingMode === "curve" && data.curveGeometry &&
      data.curveStartT !== undefined && data.curveEndT !== undefined) {
    const trimParameter = (fromSource: boolean): number => {
      const startT = data.curveStartT as number;
      const endT = data.curveEndT as number;
      const geometry = data.curveGeometry as NonNullable<ConnectorComputedData["curveGeometry"]>;
      const steps = 96;
      const trimDistance = 10.5;
      let previousT = fromSource ? startT : endT;
      let previous = evaluateConnectorCurvePoint(geometry, previousT);
      let travelled = 0;
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        const nextT = fromSource
          ? startT + (endT - startT) * ratio
          : endT - (endT - startT) * ratio;
        const next = evaluateConnectorCurvePoint(geometry, nextT);
        const segmentLength = Math.hypot(next.x - previous.x, next.y - previous.y);
        if (travelled + segmentLength >= trimDistance && segmentLength > 0.001) {
          const local = (trimDistance - travelled) / segmentLength;
          return previousT + (nextT - previousT) * local;
        }
        travelled += segmentLength;
        previousT = nextT;
        previous = next;
      }
      return fromSource ? endT : startT;
    };
    const startT = sourceLineEnd ? trimParameter(true) : data.curveStartT;
    const endT = targetLineEnd ? trimParameter(false) : data.curveEndT;
    return computeConnectorCurvePath(data.curveGeometry, Math.min(startT, endT), Math.max(startT, endT));
  }

  if (data.sourceControl && data.targetControl) {
    const sourceOffset = { x: start.x - data.srcPoint.x, y: start.y - data.srcPoint.y };
    const targetOffset = { x: end.x - data.tgtPoint.x, y: end.y - data.tgtPoint.y };
    return `M ${start.x} ${start.y} C ${data.sourceControl.x + sourceOffset.x} ${data.sourceControl.y + sourceOffset.y} ${data.targetControl.x + targetOffset.x} ${data.targetControl.y + targetOffset.y} ${end.x} ${end.y}`;
  }

  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
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

  const sourceNodeId = getConnectorEndpointNodeId(sourceEndpoint);
  const targetNodeId = getConnectorEndpointNodeId(targetEndpoint);
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
  const sourceArrowDirectionPoint = computedData.sourceArrowDirectionPoint ?? (sourceAdjacent
    ? { x: computedData.srcPoint.x * 2 - sourceAdjacent.x, y: computedData.srcPoint.y * 2 - sourceAdjacent.y }
    : computedData.sourceCenter);
  const targetArrowDirectionPoint = computedData.targetArrowDirectionPoint ?? (targetAdjacent
    ? { x: computedData.tgtPoint.x * 2 - targetAdjacent.x, y: computedData.tgtPoint.y * 2 - targetAdjacent.y }
    : computedData.targetCenter);
  const sourceLineEnd = isArrowMarker(startMarker)
    ? getArrowBasePoint(computedData.srcPoint, sourceArrowDirectionPoint)
    : undefined;
  const targetLineEnd = isArrowMarker(endMarker)
    ? getArrowBasePoint(computedData.tgtPoint, targetArrowDirectionPoint)
    : undefined;
  const visualPath = getTrimmedConnectorPath(
    computedData,
    sourceLineEnd,
    targetLineEnd,
    Number(connector.config.cornerRadius ?? 12),
  );
  const labelWidth = Math.max(48, Math.min(220, label.length * 7.4 + 20));
  const elbowHandles = computedData.elbowPoints?.slice(0, -1).flatMap((point, segmentIndex) => {
    const next = computedData.elbowPoints?.[segmentIndex + 1];
    if (!next) return [];
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    if (length < 16) return [];
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
        <path d={visualPath} fill="none" stroke="var(--conductor-accent)" strokeWidth={strokeWidth + (isSelected ? 7 : 5)} strokeLinecap="round" strokeLinejoin="round" opacity={isSelected ? 0.16 : 0.09} style={{ pointerEvents: "none" }} />
      )}
      {renderVisuals && <path d={computedData.path} fill="none" stroke="transparent" strokeWidth={HIT_TARGET_WIDTH} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "auto" }} />}
      {renderVisuals && <path
        d={visualPath}
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

      {renderControls && isSelected && computedData.routingMode === "curve" && (
        <>
          {computedData.curveActivated && computedData.sourceControl && computedData.targetControl && (
            <>
              {(["source", "target"] as const).map((control) => {
                const point = control === "source" ? computedData.sourceControl : computedData.targetControl;
                if (!point) return null;
                return <circle data-testid={`connector-curve-${control}-control`} key={control} cx={point.x} cy={point.y} r={5} fill="var(--conductor-accent)" stroke="var(--conductor-accent)" strokeWidth={1.5} style={{ cursor: "move", pointerEvents: "auto" }} onPointerDown={(event) => onCurveControlPointerDown?.(connector.id, control, point, event)} />;
              })}
            </>
          )}
          <circle
            data-testid="connector-curve-midpoint-control"
            cx={computedData.midPoint.x}
            cy={computedData.midPoint.y}
            r={computedData.curveActivated ? 6 : 5}
            fill={computedData.curveActivated ? "var(--canvas-bg)" : "var(--conductor-accent)"}
            stroke="var(--conductor-accent)"
            strokeWidth={computedData.curveActivated ? 2 : 1.5}
            style={{ cursor: "move", pointerEvents: "auto" }}
            onPointerDown={(event) => onCurveControlPointerDown?.(connector.id, "midpoint", computedData.midPoint, event)}
          />
        </>
      )}

      {renderControls && isSelected && computedData.routingMode === "elbow" && elbowHandles.map((handle) => (
        <g key={`${handle.segmentIndex}-${handle.orientation}`}>
          <rect
            data-testid="connector-elbow-handle"
            data-segment-index={handle.segmentIndex}
            x={handle.point.x - 11}
            y={handle.point.y - 11}
            width={22}
            height={22}
            fill="transparent"
            style={{ cursor: handle.orientation === "horizontal" ? "ns-resize" : "ew-resize", pointerEvents: "auto" }}
            onPointerDown={(event) => onElbowSegmentPointerDown?.(connector.id, handle.segmentIndex, handle.orientation, event)}
          />
          <rect
            x={handle.point.x - (handle.orientation === "horizontal" ? 7 : 3.5)}
            y={handle.point.y - (handle.orientation === "horizontal" ? 3.5 : 7)}
            width={handle.orientation === "horizontal" ? 14 : 7}
            height={handle.orientation === "horizontal" ? 7 : 14}
            rx={2.5}
            fill="var(--canvas-bg)"
            stroke="var(--conductor-accent)"
            strokeWidth={1.8}
            style={{ pointerEvents: "none" }}
          />
        </g>
      ))}

      {renderControls && isSelected && (["source", "target"] as const).map((endpoint) => {
        const edgePoint = endpoint === "source" ? computedData.srcPoint : computedData.tgtPoint;
        const referencePoint = endpoint === "source" ? computedData.sourceReference : computedData.targetReference;
        const guidePath = computedData.routingMode === "curve" && computedData.curveGeometry &&
          computedData.curveStartT !== undefined && computedData.curveEndT !== undefined
          ? endpoint === "source"
            ? computeConnectorCurvePath(computedData.curveGeometry, 0, computedData.curveStartT)
            : computeConnectorCurvePath(computedData.curveGeometry, computedData.curveEndT, 1)
          : `M ${referencePoint.x} ${referencePoint.y} L ${edgePoint.x} ${edgePoint.y}`;
        return (
          <g key={endpoint}>
            <path d={guidePath} stroke="var(--conductor-accent)" fill="none" strokeWidth={1.4} strokeDasharray="5 5" opacity={0.65} style={{ pointerEvents: "none" }} />
            <circle data-testid={`connector-${endpoint}-reference-handle`} cx={referencePoint.x} cy={referencePoint.y} r={12} fill="transparent" style={{ cursor: "grab", pointerEvents: "auto" }} onPointerDown={(event) => onEndpointPointerDown?.(connector.id, endpoint, referencePoint, event)} />
            <circle cx={referencePoint.x} cy={referencePoint.y} r={6} fill="var(--canvas-bg)" stroke="var(--conductor-accent)" strokeWidth={2} style={{ pointerEvents: "none" }} />
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
