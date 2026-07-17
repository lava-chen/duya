"use client";

import React, { memo, useMemo } from "react";
import type { CanvasElement, CanvasPosition } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { ElementRenderer } from "./ElementRenderer";
import { gridUnitsToPx } from "../domain/canvas/units";

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
  // Native elements provide their own selection chrome. Keeping a second
  // wrapper outline here caused the blue glow to sit underneath their
  // purple handles and made one selection look like two competing states.
  const showWrapperSelection = selected && !element.elementKind.startsWith("native/");

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
        // Native cards own a separate visual layer below their interaction
        // chrome. Rotating this outer box also rotated the selection bounds,
        // resize handles, toolbar and text-edit hit area. Keep native layout
        // coordinates stable and let NativeChrome rotate only its content.
        // Non-native widgets still own their complete visual chrome here.
        transform: element.elementKind.startsWith("native/")
          ? undefined
          : `rotate(${element.position.rotation ?? 0}deg)`,
        cursor: readOnly ? "default" : "grab",
        userSelect: editing ? "text" : "none",
        outline: showWrapperSelection ? "2px solid var(--accent)" : "none",
        outlineOffset: showWrapperSelection ? "3px" : 0,
        boxShadow: showWrapperSelection ? "0 0 0 6px var(--accent-soft)" : undefined,
        borderRadius: showWrapperSelection ? 14 : undefined,
        pointerEvents: "auto",
      }}
    >
      <ElementRenderer
        element={element}
        readOnly={readOnly}
        selected={selected}
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
    // Render all free-form-positioned elements through a single layer so they
    // share the same drag/resize interaction model. Widgets used to live in a
    // separate react-grid-layout layer with grid snapping and a mismatched red
    // placeholder; moving them here gives them the same free-form drag feel as
    // sticky notes, plus the same alignment-snapping behavior.
    return elements
      .filter((el) => !isConnectorElement(el) && !isGroupElement(el))
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
