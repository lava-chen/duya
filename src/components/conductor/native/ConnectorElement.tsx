"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "@/types/conductor";
import type { ConnectorEndpoint, AnchorId, Point } from "@/types/canvas-node";
import { useConductorStore } from "@/stores/conductor-store";
import {
  getAnchorPosition,
  getConnectorEndpoint,
  anchorToDirection,
  autoDirection,
  computeBezierPath,
  computeStraightPath,
} from "@/conductor/canvas/connector-renderer";

const HIT_TARGET_WIDTH = 12;

interface ConnectorPathProps {
  connector: CanvasElement;
  elements: CanvasElement[];
  isSelected: boolean;
  onClick?: (connectorId: string) => void;
}

export const ConnectorPath: React.FC<ConnectorPathProps> = ({
  connector,
  elements,
  isSelected,
  onClick,
}) => {
  const sourceEndpoint = connector.config.source as ConnectorEndpoint | undefined;
  const targetEndpoint = connector.config.target as ConnectorEndpoint | undefined;
  const curvature = (connector.config.curvature as number) || 0.4;
  const routingMode = (connector.config.routingMode as string) || "bezier";
  const style = connector.config.style as Record<string, unknown> | undefined;
  const stroke = (style?.stroke as string) || "var(--accent)";
  const strokeWidth = (style?.strokeWidth as number) || 2;
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

  const computedData = useMemo(() => {
    if (!sourceEndpoint || !targetEndpoint) return null;
    if (!sourcePos || !targetPos) return null;

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
      };
    }

    const srcDir = anchorToDirection(srcAnchor) || autoDirection(srcPoint, tgtPoint);
    const tgtDir = anchorToDirection(tgtAnchor) || autoDirection(tgtPoint, srcPoint);

    return {
      path: computeBezierPath(srcPoint, srcDir, tgtPoint, tgtDir, curvature),
      srcPoint,
      tgtPoint,
    };
  }, [sourceEndpoint, targetEndpoint, sourcePos, targetPos, sourceNodeId, targetNodeId, elements, routingMode, curvature]);

  const markerEndUrl = endMarker === "arrow" ? "url(#connector-arrowhead)" : undefined;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(connector.id);
  };

  if (!computedData) return null;

  return (
    <g onClick={handleClick} style={{ cursor: "pointer" }}>
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
        stroke={isSelected ? "var(--accent)" : stroke}
        strokeWidth={isSelected ? strokeWidth + 1 : strokeWidth}
        strokeLinecap="round"
        markerEnd={markerEndUrl}
        style={{ pointerEvents: "none" }}
        opacity={isSelected ? 1 : undefined}
      />
      {isSelected && (
        <>
          <circle
            cx={computedData.srcPoint.x}
            cy={computedData.srcPoint.y}
            r={5}
            fill="var(--main-bg)"
            stroke="var(--accent)"
            strokeWidth={2}
          />
          <circle
            cx={computedData.tgtPoint.x}
            cy={computedData.tgtPoint.y}
            r={5}
            fill="var(--main-bg)"
            stroke="var(--accent)"
            strokeWidth={2}
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
          id="connector-arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
        >
          <polygon
            points="0 0, 10 3.5, 0 7"
            fill="var(--accent)"
          />
        </marker>
      </defs>
      <ConnectorPath
        connector={element}
        elements={elements}
        isSelected={isSelected}
      />
    </svg>
  );
};