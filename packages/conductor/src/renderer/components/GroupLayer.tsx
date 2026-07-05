"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { GroupElement } from "./native/GroupElement";

interface GroupLayerProps {
  elements: CanvasElement[];
}

function isGroupElement(element: CanvasElement): boolean {
  return element.elementKind === "native/group";
}

/**
 * Renders group elements with the lowest z-index so they appear behind
 * all other elements. Groups are filtered out of FreeformLayer and
 * rendered here instead. Member elements, which live in FreeformLayer,
 * sit visually above the group frames and receive their own clicks.
 */
export const GroupLayer: React.FC<GroupLayerProps> = ({ elements }) => {
  const groupElements = useMemo(
    () => elements.filter(isGroupElement),
    [elements],
  );

  if (groupElements.length === 0) return null;

  return (
    <div
      className="group-layer"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {groupElements.map((el) => (
        <GroupElement key={el.id} element={el} />
      ))}
    </div>
  );
};
