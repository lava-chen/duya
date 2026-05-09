"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";

interface ConnectorOverlayProps {
  elements: CanvasElement[];
}

function getElementCenter(el: CanvasElement): { x: number; y: number } {
  return {
    x: el.position.x + el.position.w * 40,
    y: el.position.y + el.position.h * 40,
  };
}

export const ConnectorOverlay: React.FC<ConnectorOverlayProps> = ({ elements }) => {
  const connectors = elements.filter(
    (el) => el.elementKind === "shape/connector"
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
        zIndex: 2,
      }}
    >
      <defs>
        <marker
          id="arrowhead"
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

        return (
          <line
            key={conn.id}
            x1={sourcePos.x}
            y1={sourcePos.y}
            x2={targetPos.x}
            y2={targetPos.y}
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray={style === "dashed" ? "6 3" : undefined}
            markerEnd={arrow ? "url(#arrowhead)" : undefined}
          />
        );
      })}
    </svg>
  );
};