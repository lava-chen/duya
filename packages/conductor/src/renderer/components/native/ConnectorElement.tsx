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
} from "../..//domain/canvas/connector-renderer";

const HIT_TARGET_WIDTH = 20;
const DEFAULT_CONNECTOR_COLOR = "var(--text-secondary)";

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
  return config.routingMode === "elbow" ? "elbow" : "curve";
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
  const normalizedX = (otherCenter.x - center.x) / halfWidth;
  const normalizedY = (otherCenter.y - center.y) / halfHeight;
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
  if (Number.isFinite(endpoint.edgePosition)) {
    return { anchorId, edgePosition: Math.max(0, Math.min(1, endpoint.edgePosition as number)) };
  }

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
    const points = computeElbowRoutePoints(srcPoint, srcDir, tgtPoint, tgtDir, waypoints);
    return {
      path: computeRoundedElbowPath(points, Number(connector.config.cornerRadius ?? 14)),
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
  center,
  color,
  testId,
}: {
  marker: ConnectorMarker;
  tip: Point;
  center: Point;
  color: string;
  testId: string;
}) {
  if (marker !== "arrow" && marker !== "open-arrow") return null;
  const { left, right } = getConnectorArrowGeometry(tip, center);
  if (marker === "open-arrow") {
    return (
      <path
        data-testid={testId}
        d={`M ${left.x} ${left.y} L ${tip.x} ${tip.y} L ${right.x} ${right.y}`}
        fill="none"
        stroke={color}
        strokeWidth={2.2}
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
  const strokeWidth = 2.5;
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
      {renderVisuals && <ConnectorArrow marker={startMarker} tip={computedData.srcPoint} center={computedData.sourceCenter} color={renderStroke} testId="connector-start-arrow" />}
      {renderVisuals && <ConnectorArrow marker={endMarker} tip={computedData.tgtPoint} center={computedData.targetCenter} color={renderStroke} testId="connector-end-arrow" />}

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
