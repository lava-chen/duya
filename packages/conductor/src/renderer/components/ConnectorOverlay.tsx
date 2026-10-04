"use client";

import React, { useId } from "react";
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

/**
 * Legacy connector path: center-to-center beziers for connector records whose
 * endpoints predate `config.source` / `config.target` and live in
 * `vizSpec.payload.sourceId` / `targetId` instead.
 *
 * This is the ONLY renderer for that older record shape — the native path
 * (`ConnectorItem` -> `ConnectorPath`) bails out at
 * `getComputedConnectorData` when `config.source` or `config.target` is
 * missing, and this overlay's filter below is the exact complement of that
 * condition. So the two paths never draw the same connector twice; removing
 * either one would leave its record shape invisible.
 */
export const ConnectorOverlay: React.FC<ConnectorOverlayProps> = ({ elements }) => {
  const connectors = elements.filter(
    (el) => el.elementKind === "native/connector" &&
      !(el.config.source && el.config.target)
  );

  // SVG marker ids share one document-wide namespace, so a hard-coded
  // `arrowhead` collides with any other overlay in the same document (the main
  // and sidebar conductor views can both be mounted). `useId` keeps the
  // `url(#...)` reference bound to this instance's own <defs>.
  const markerId = `connector-legacy-arrowhead-${useId()}`;

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
          id={markerId}
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
            markerEnd={arrow ? `url(#${markerId})` : undefined}
            color="var(--accent)"
            style={{ pointerEvents: "none" }}
          />
        );
      })}
    </svg>
  );
};
