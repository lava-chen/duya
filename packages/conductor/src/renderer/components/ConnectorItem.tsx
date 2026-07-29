"use client";

import React, { useState } from "react";
import type { CanvasElement } from "..//types/conductor";
import { ConnectorPath } from "./native/ConnectorElement";
import { useConductorStore } from "..//stores/conductor-store";

interface ConnectorItemProps {
  connector: CanvasElement;
  elements: CanvasElement[];
}

export const ConnectorItem: React.FC<ConnectorItemProps> = ({ connector, elements }) => {
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const [isHovered, setIsHovered] = useState(false);
  const isSelected = selectedElementId === connector.id;

  return (
    <div
      data-native-element-id={connector.id}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: connector.position.zIndex,
      }}
    >
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        <ConnectorPath
          connector={connector}
          elements={elements}
          isSelected={isSelected}
          isHovered={isHovered}
          layer="visual"
          onHover={(id) => setIsHovered(id !== null)}
          onClick={(id) => setSelectedElementId(id === selectedElementId ? null : id)}
        />
      </svg>
    </div>
  );
};
