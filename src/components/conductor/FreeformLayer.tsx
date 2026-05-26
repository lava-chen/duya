"use client";

import React, { memo, useMemo } from "react";
import type { CanvasElement, CanvasPosition } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { ElementRenderer } from "./ElementRenderer";

const GRID_PX = 80;

function isWidgetKind(element: CanvasElement): boolean {
  return element.elementKind.startsWith("widget/");
}

function isConnectorElement(element: CanvasElement): boolean {
  return element.elementKind === "shape/connector" || element.elementKind === "native/connector";
}

interface FreeformLayerProps {
  elements: CanvasElement[];
  readOnly: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
}

function elementSizeToPx(size: number): number {
  return Math.round(size * GRID_PX);
}

interface FreeformItemProps {
  element: CanvasElement;
  readOnly: boolean;
  selected: boolean;
  editing: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
}

const FreeformItem = memo(function FreeformItem({
  element,
  readOnly,
  selected,
  editing,
  onPositionChange,
  onDeleteElement,
}: FreeformItemProps) {
  return (
    <div
      id={`native-el-${element.id}`}
      data-native-element-id={element.id}
      style={{
        position: "absolute",
        left: element.position.x,
        top: element.position.y,
        width: elementSizeToPx(element.position.w),
        height: elementSizeToPx(element.position.h),
        zIndex: element.position.zIndex,
        transform: `rotate(${element.position.rotation ?? 0}deg)`,
        cursor: readOnly ? "default" : "grab",
        userSelect: editing ? "text" : "none",
        outline: selected ? "2px solid var(--accent)" : "none",
        outlineOffset: selected ? "3px" : 0,
        boxShadow: selected ? "0 0 0 6px var(--accent-soft)" : undefined,
        borderRadius: selected ? 14 : undefined,
        pointerEvents: "auto",
      }}
    >
      <ElementRenderer
        element={element}
        readOnly={readOnly}
        onDelete={onDeleteElement}
        onPositionChange={
          onPositionChange
            ? (id: string) => {
                const pos = useConductorStore.getState().elements.find((el) => el.id === id)?.position;
                if (pos) onPositionChange(id, pos);
              }
            : undefined
        }
      />
    </div>
  );
});

export const FreeformLayer: React.FC<FreeformLayerProps> = ({
  elements,
  readOnly,
  onPositionChange,
  onDeleteElement,
}) => {
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const editingElementId = useConductorStore((state) => state.editingElementId);

  const sorted = useMemo(() => {
    return elements
      .filter((el) => !isWidgetKind(el) && !isConnectorElement(el))
      .slice()
      .sort((a, b) => a.position.zIndex - b.position.zIndex);
  }, [elements]);

  const selectedSet = useMemo(() => new Set(selectedElementIds), [selectedElementIds]);

  return (
    <div className="freeform-layer" style={{ position: "relative", width: "100%", height: "100%" }}>
      {sorted.map((el) => (
        <FreeformItem
          key={el.id}
          element={el}
          readOnly={readOnly}
          selected={selectedSet.has(el.id)}
          editing={editingElementId === el.id}
          onPositionChange={onPositionChange}
          onDeleteElement={onDeleteElement}
        />
      ))}
    </div>
  );
};
