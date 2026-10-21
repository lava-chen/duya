"use client";

import React from "react";
import type { CanvasElement } from "..//types/conductor";
import { GRID_PX, autoDirection, computeBezierPath } from "..//domain/canvas/connector-renderer";

interface ConnectorOverlayProps {
  elements: CanvasElement[];
}

function getElementCenter(el: CanvasElement): { x: number; y: number } {
  return {
    x: el.position.x * GRID_PX + (el.position.w * GRID_PX) / 2,
    y: el.position.y * GRID_PX + (el.position.h * GRID_PX) / 2,
  };
}

export const ConnectorOverlay: React.FC<ConnectorOverlayProps> = ({ elements }) => {
  const connectors = elements.filter(
    (el) => el.elementKind === "native/connector" &&
      !(el.config.source && el.config.target)
  );

  if (connectors.length === 0) return null;

  return (
    <svg
      className="connector-overlay"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="6"
          markerHeight="4.5"
          refX="6"
          refY="2.25"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <polygon
            points="0 0, 6 2.25, 0 4.5"
            fill="currentColor"
          />
        </marker>
      </defs>
      {connectors.map((conn) => {
        const sourceId = conn.vizSpec?.payload?.sourceId as string | undefined;
        const targetId = conn.vizSpec?.payload?.targetId as string | undefined;
        const style = conn.vizSpec?.payload?.style as string | undefined;
        const arrow = conn.vizSpec?.payload?.arrow !== false;

        const sourceEl = sourceId
          ? elements.find((e) => e.id === sourceId)
          : undefined;
        const targetEl = targetId
          ? elements.find((e) => e.id === targetId)
          : undefined;

        if (!sourceEl || !targetEl) return null;

        const sourcePos = getElementCenter(sourceEl);
        const targetPos = getElementCenter(targetEl);
        const pathD = computeBezierPath(
          sourcePos,
          autoDirection(sourcePos, targetPos),
          targetPos,
          autoDirection(targetPos, sourcePos),
          0.4,
        );

        return (
          <path
            key={conn.id}
            d={pathD}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={style === "dashed" ? "6 3" : undefined}
            markerEnd={arrow ? "url(#arrowhead)" : undefined}
            color="var(--accent)"
            style={{ pointerEvents: "none" }}
          />
        );
      })}
    </svg>
  );
};
