"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "../..//types/conductor";
import type { ConnectorEndpoint, AnchorId, Point } from "../..//types/canvas-node";
import { useConductorStore } from "../..//stores/conductor-store";
import {
  getAnchorPosition,
  getConnectorEndpoint,
  anchorToDirection,
  autoDirection,
  computeBezierPath,
  computeStraightPath,
  evaluateBezierPoint,
} from "../..//domain/canvas/connector-renderer";

const HIT_TARGET_WIDTH = 20;

export interface ConnectorComputedData {
  path: string;
  srcPoint: Point;
  tgtPoint: Point;
  midPoint: Point;
}

interface ConnectorPathProps {
  connector: CanvasElement;
  elements: CanvasElement[];
  isSelected: boolean;
  isHovered?: boolean;
  onClick?: (connectorId: string) => void;
  onHover?: (connectorId: string | null) => void;
  onEndpointPointerDown?: (
    connectorId: string,
    endpoint: "source" | "target",
    point: Point,
    event: React.PointerEvent<SVGCircleElement>
  ) => void;
}

export function getComputedConnectorData(
  connector: CanvasElement,
  elements: CanvasElement[],
  sourcePos: CanvasElement["position"] | null,
  targetPos: CanvasElement["position"] | null
): ConnectorComputedData | null {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  const curvature = (connector.config.curvature as number) || 0.4;
  const routingMode = (connector.config.routingMode as string) || "bezier";

  if (!sourceEndpoint || !targetEndpoint || !sourcePos || !targetPos) return null;

  const sourceNodeId = sourceEndpoint.nodeId;
  const targetNodeId = targetEndpoint.nodeId;
  const sourceNode = elements.find((e) => e.id === sourceNodeId);
  const targetNode = elements.find((e) => e.id === targetNodeId);
  if (!sourceNode || !targetNode) return null;

  const srcAnchor = (sourceEndpoint.anchorId || "center") as AnchorId;
  const tgtAnchor = (targetEndpoint.anchorId || "center") as AnchorId;

  const rawSrcPoint = getAnchorPosition(sourceNode, srcAnchor, elements);
  const rawTgtPoint = getAnchorPosition(targetNode, tgtAnchor, elements);

  const srcPoint = getConnectorEndpoint(sourceNode, srcAnchor, elements, rawTgtPoint);
  const tgtPoint = getConnectorEndpoint(targetNode, tgtAnchor, elements, rawSrcPoint);

  if (routingMode === "straight") {
    return {
      path: computeStraightPath(srcPoint, tgtPoint),
      srcPoint,
      tgtPoint,
      midPoint: {
        x: (srcPoint.x + tgtPoint.x) / 2,
        y: (srcPoint.y + tgtPoint.y) / 2,
      },
    };
  }

  const srcDir = anchorToDirection(srcAnchor) || autoDirection(srcPoint, tgtPoint);
  const tgtDir = anchorToDirection(tgtAnchor) || autoDirection(tgtPoint, srcPoint);

  return {
    path: computeBezierPath(srcPoint, srcDir, tgtPoint, tgtDir, curvature),
    srcPoint,
    tgtPoint,
    midPoint: evaluateBezierPoint(srcPoint, srcDir, tgtPoint, tgtDir, curvature, 0.5),
  };
}

export const ConnectorPath: React.FC<ConnectorPathProps> = ({
  connector,
  elements,
  isSelected,
  isHovered = false,
  onClick,
  onHover,
  onEndpointPointerDown,
}) => {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  const style = connector.config.style as Record<string, unknown> | undefined;
  const stroke = (style?.stroke as string) || "var(--text-secondary)";
  const strokeWidth = Number(style?.strokeWidth ?? 2);
  const endMarker = (style?.endMarker as string) || "arrow";

  const sourceNodeId = sourceEndpoint?.nodeId;
  const targetNodeId = targetEndpoint?.nodeId;

  const sourcePos = useConductorStore((state) => {
    if (!sourceNodeId) return null;
    const el = state.elements.find((e) => e.id === sourceNodeId);
    return el ? el.position : null;
  });

  const targetPos = useConductorStore((state) => {
    if (!targetNodeId) return null;
    const el = state.elements.find((e) => e.id === targetNodeId);
    return el ? el.position : null;
  });

  const computedData = useMemo(
    () => getComputedConnectorData(connector, elements, sourcePos, targetPos),
    [connector, elements, sourcePos, targetPos]
  );

  if (!computedData) return null;

  const markerEndUrl = endMarker === "arrow" ? "url(#native-connector-arrowhead)" : undefined;

  return (
    <g
      style={{ cursor: "pointer" }}
      onPointerEnter={() => onHover?.(connector.id)}
      onPointerLeave={() => onHover?.(null)}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(connector.id);
      }}
    >
      <path
        d={computedData.path}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_TARGET_WIDTH}
        strokeLinecap="round"
        style={{ pointerEvents: "auto" }}
      />
      <path
        d={computedData.path}
        fill="none"
        stroke={isSelected ? "var(--conductor-accent)" : stroke}
        strokeWidth={isSelected ? strokeWidth + 0.5 : strokeWidth}
        strokeLinecap="round"
        markerEnd={markerEndUrl}
        style={{ pointerEvents: "none", transition: "stroke var(--motion-duration-micro) var(--motion-smooth), stroke-width var(--motion-duration-micro) var(--motion-smooth)" }}
      />
      {(isHovered || isSelected) && (
        <path
          d={computedData.path}
          fill="none"
          stroke="var(--conductor-accent)"
          strokeWidth={strokeWidth + (isSelected ? 6 : 4)}
          strokeLinecap="round"
          opacity={isSelected ? 0.18 : 0.1}
          style={{ pointerEvents: "none" }}
        />
      )}

      {isSelected && (
        <>
          <circle
            cx={computedData.srcPoint.x}
            cy={computedData.srcPoint.y}
            r={6}
            fill="var(--canvas-bg)"
            stroke="var(--conductor-accent)"
            strokeWidth={2}
            style={{ cursor: "grab", pointerEvents: "auto" }}
            onPointerDown={(event) =>
              onEndpointPointerDown?.(connector.id, "source", computedData.srcPoint, event)
            }
          />
          <circle
            cx={computedData.tgtPoint.x}
            cy={computedData.tgtPoint.y}
            r={6}
            fill="var(--canvas-bg)"
            stroke="var(--conductor-accent)"
            strokeWidth={2}
            style={{ cursor: "grab", pointerEvents: "auto" }}
            onPointerDown={(event) =>
              onEndpointPointerDown?.(connector.id, "target", computedData.tgtPoint, event)
            }
          />
        </>
      )}
    </g>
  );
};

interface ConnectorElementProps {
  element: CanvasElement;
}

export const ConnectorElement: React.FC<ConnectorElementProps> = ({ element }) => {
  const elements = useConductorStore((state) => state.elements);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const isSelected = selectedElementId === element.id;

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="native-connector-arrowhead"
          markerWidth="12"
          markerHeight="12"
          refX="10"
          refY="6"
          orient="auto-start-reverse"
        >
          <path
            d="M 1 1 Q 6 6 1 11 L 10 6 Z"
            fill="var(--text-secondary)"
            stroke="var(--text-secondary)"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <ConnectorPath connector={element} elements={elements} isSelected={isSelected} />
    </svg>
  );
};
