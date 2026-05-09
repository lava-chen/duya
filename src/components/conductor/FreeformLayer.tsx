"use client";

import React, { useCallback, useRef, useState } from "react";
import type { CanvasElement, CanvasPosition } from "@/types/conductor";
import { ElementRenderer } from "./ElementRenderer";

function isWidgetKind(element: CanvasElement): boolean {
  return element.elementKind.startsWith("widget/");
}

function isConnectorElement(element: CanvasElement): boolean {
  return element.elementKind === "shape/connector";
}

interface FreeformLayerProps {
  elements: CanvasElement[];
  readOnly: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
}

function elementSizeToPx(size: number): number {
  return Math.round(size * 80);
}

export const FreeformLayer: React.FC<FreeformLayerProps> = ({
  elements,
  readOnly,
  onPositionChange,
  onDeleteElement,
}) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; elX: number; elY: number } | null>(null);

  const freeformElements = elements.filter(
    (el) => !isWidgetKind(el) && !isConnectorElement(el)
  );

  const sorted = [...freeformElements].sort(
    (a, b) => a.position.zIndex - b.position.zIndex
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, el: CanvasElement) => {
      if (readOnly) return;
      e.stopPropagation();
      setDraggingId(el.id);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        elX: el.position.x,
        elY: el.position.y,
      };
    },
    [readOnly]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingId || !dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      const newX = Math.max(0, dragStartRef.current.elX + dx);
      const newY = Math.max(0, dragStartRef.current.elY + dy);

      const el = elements.find((el) => el.id === draggingId);
      if (!el) return;

      onPositionChange?.(draggingId, {
        ...el.position,
        x: newX,
        y: newY,
      });
    },
    [draggingId, elements, onPositionChange]
  );

  const handleMouseUp = useCallback(() => {
    setDraggingId(null);
    dragStartRef.current = null;
  }, []);

  return (
    <div
      className="freeform-layer"
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {sorted.map((el) => (
        <div
          key={el.id}
          onMouseDown={(e) => handleMouseDown(e, el)}
          style={{
            position: "absolute",
            left: el.position.x,
            top: el.position.y,
            width: elementSizeToPx(el.position.w),
            height: elementSizeToPx(el.position.h),
            zIndex: el.position.zIndex,
            transform: `rotate(${el.position.rotation ?? 0}deg)`,
            cursor: draggingId === el.id ? "grabbing" : readOnly ? "default" : "grab",
            userSelect: "none",
          }}
        >
          <ElementRenderer
            element={el}
            readOnly={readOnly}
            onDelete={onDeleteElement}
          />
        </div>
      ))}
    </div>
  );
};