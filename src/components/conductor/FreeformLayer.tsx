"use client";

import React from "react";
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

export const FreeformLayer: React.FC<FreeformLayerProps> = ({
  elements,
  readOnly,
  onPositionChange,
  onDeleteElement,
}) => {
  const { selectedElementIds, editingElementId } = useConductorStore();

  const freeformElements = elements.filter(
    (el) => !isWidgetKind(el) && !isConnectorElement(el)
  );

  const sorted = [...freeformElements].sort(
    (a, b) => a.position.zIndex - b.position.zIndex
  );

  return (
    <div
      className="freeform-layer"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {sorted.map((el) => (
        <div
          key={el.id}
          id={`native-el-${el.id}`}
          data-native-element-id={el.id}
          style={{
            position: "absolute",
            left: el.position.x,
            top: el.position.y,
            width: elementSizeToPx(el.position.w),
            height: elementSizeToPx(el.position.h),
            zIndex: el.position.zIndex,
            transform: `rotate(${el.position.rotation ?? 0}deg)`,
            cursor: readOnly ? "default" : "grab",
            userSelect: editingElementId === el.id ? "text" : "none",
            outline:
              selectedElementIds.includes(el.id)
                ? "2px solid var(--accent)"
                : "none",
            outlineOffset: "2px",
          }}
        >
          <ElementRenderer
            element={el}
            readOnly={readOnly}
            onDelete={onDeleteElement}
            onPositionChange={
              onPositionChange
                ? (id: string) => {
                    const pos = useConductorStore.getState().elements.find(el => el.id === id)?.position;
                    if (pos) onPositionChange(id, pos);
                  }
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
};