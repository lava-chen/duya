"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";

type HandleDirection = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_SIZE = 8;
const MIN_SIZE_GRID = 1;

interface NativeChromeProps {
  element: CanvasElement;
  children: React.ReactNode;
  onPositionChange?: (id: string) => void;
}

export const NativeChrome: React.FC<NativeChromeProps> = ({ element, children, onPositionChange }) => {
  const {
    selectedElementId,
    setSelectedElementId,
    editingElementId,
    setEditingElementId,
    updateElement,
  } = useConductorStore();

  const isSelected = selectedElementId === element.id;

  const resizeRef = useRef<{
    dir: HandleDirection;
    startMouseX: number;
    startMouseY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
  } | null>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isSelected) {
        setEditingElementId(element.id);
      } else {
        setSelectedElementId(element.id);
      }
    },
    [isSelected, element.id, setSelectedElementId, setEditingElementId]
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, dir: HandleDirection) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        dir,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        origW: element.position.w,
        origH: element.position.h,
        origX: element.position.x,
        origY: element.position.y,
      };
    },
    [element.position]
  );

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;

      const dx = e.clientX - r.startMouseX;
      const dy = e.clientY - r.startMouseY;
      const gridUnit = 80;

      let newW = r.origW;
      let newH = r.origH;
      let newX = r.origX;
      let newY = r.origY;

      const dw = Math.round(dx / gridUnit);
      const dh = Math.round(dy / gridUnit);

      switch (r.dir) {
        case "e":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          break;
        case "w":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newX = r.origX + r.origW - newW;
          break;
        case "s":
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          break;
        case "n":
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newY = r.origY + r.origH - newH;
          break;
        case "ne":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newY = r.origY + r.origH - newH;
          break;
        case "nw":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newX = r.origX + r.origW - newW;
          newY = r.origY + r.origH - newH;
          break;
        case "se":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          break;
        case "sw":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          newX = r.origX + r.origW - newW;
          break;
      }

      updateElement(element.id, {
        position: {
          ...element.position,
          x: newX,
          y: newY,
          w: newW,
          h: newH,
        },
      });
    };

    const handleGlobalMouseUp = () => {
      const wasResizing = resizeRef.current !== null;
      resizeRef.current = null;
      if (wasResizing && onPositionChange) {
        onPositionChange(element.id);
      }
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [element.id, element.position, updateElement]);

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: "var(--main-bg)",
    border: "2px solid var(--accent)",
    borderRadius: 2,
    zIndex: 10,
    pointerEvents: "auto",
  };

  const isEditing = editingElementId === element.id;

  return (
    <div
      className="native-chrome"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        outline: isSelected ? "2px solid var(--accent)" : "none",
        outlineOffset: -1,
        borderRadius: 4,
        cursor: isEditing ? "text" : "default",
      }}
      onClick={handleClick}
    >
      {children}

      {isSelected && !isEditing && (
        <>
          <div
            data-resize-handle="nw"
            style={{ ...handleStyle, top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "nw")}
          />
          <div
            data-resize-handle="n"
            style={{ ...handleStyle, top: -HANDLE_SIZE / 2, left: "calc(50% - 4px)", cursor: "ns-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "n")}
          />
          <div
            data-resize-handle="ne"
            style={{ ...handleStyle, top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "ne")}
          />
          <div
            data-resize-handle="e"
            style={{ ...handleStyle, top: "calc(50% - 4px)", right: -HANDLE_SIZE / 2, cursor: "ew-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "e")}
          />
          <div
            data-resize-handle="se"
            style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "se")}
          />
          <div
            data-resize-handle="s"
            style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, left: "calc(50% - 4px)", cursor: "ns-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "s")}
          />
          <div
            data-resize-handle="sw"
            style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "sw")}
          />
          <div
            data-resize-handle="w"
            style={{ ...handleStyle, top: "calc(50% - 4px)", left: -HANDLE_SIZE / 2, cursor: "ew-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "w")}
          />
        </>
      )}
    </div>
  );
};