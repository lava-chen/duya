"use client";

import React, { memo, useMemo } from "react";
import type { CanvasElement, CanvasPosition } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { ElementRenderer } from "./ElementRenderer";
import { gridUnitsToPx } from "../domain/canvas/units";

function isWidgetKind(element: CanvasElement): boolean {
  return element.elementKind.startsWith("widget/");
}

function isConnectorElement(element: CanvasElement): boolean {
  return element.elementKind === "native/connector";
}

function isGroupElement(element: CanvasElement): boolean {
  return element.elementKind === "native/group";
}

interface FreeformLayerProps {
  elements: CanvasElement[];
  readOnly: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
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
        // position.x/y are persisted in grid units; convert to pixels here
        // so the layout box matches the size computed from w/h below.
        position: "absolute",
        left: gridUnitsToPx(element.position.x),
        top: gridUnitsToPx(element.position.y),
        width: gridUnitsToPx(element.position.w),
        height: gridUnitsToPx(element.position.h),
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
      .filter((el) => !isWidgetKind(el) && !isConnectorElement(el) && !isGroupElement(el))
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
