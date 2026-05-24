"use client";

import React, { useCallback } from "react";
import type { CanvasElement } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { ConnectorPath } from "./native/ConnectorElement";

interface NativeConnectorOverlayProps {
  elements: CanvasElement[];
}

export const NativeConnectorOverlay: React.FC<NativeConnectorOverlayProps> = ({
  elements,
}) => {
  const selectedElementId = useConductorStore(
    (state) => state.selectedElementId
  );
  const setSelectedElementId = useConductorStore(
    (state) => state.setSelectedElementId
  );

  const connectors = elements.filter(
    (el) => el.elementKind === "native/connector"
  );

  const handleConnectorClick = useCallback(
    (connectorId: string) => {
      setSelectedElementId(
        selectedElementId === connectorId ? null : connectorId
      );
    },
    [selectedElementId, setSelectedElementId]
  );

  if (connectors.length === 0) return null;

  return (
    <svg
      className="native-connector-overlay"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 3,
        overflow: "visible",
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
          <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent)" />
        </marker>
      </defs>
      {connectors.map((conn) => (
        <ConnectorPath
          key={conn.id}
          connector={conn}
          elements={elements}
          isSelected={selectedElementId === conn.id}
          onClick={handleConnectorClick}
        />
      ))}
    </svg>
  );
};