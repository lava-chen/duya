"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { canvasTransformState } from "../CanvasArea";

type HandleDirection = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_SIZE = 8;
const MIN_SIZE_GRID = 1;
const GRID_UNIT = 80;

interface NativeChromeProps {
  element: CanvasElement;
  children: React.ReactNode;
  onPositionChange?: (id: string) => void;
}

export const NativeChrome: React.FC<NativeChromeProps> = ({ element, children, onPositionChange }) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const updateElement = useConductorStore((state) => state.updateElement);

  const isSelected = selectedElementId === element.id || selectedElementIds.includes(element.id);
  const isEditing = editingElementId === element.id;

  const resizeRef = useRef<{
    dir: HandleDirection;
    startMouseX: number;
    startMouseY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
    rafId: number | null;
    lastMouseX: number;
    lastMouseY: number;
  } | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedElementId(element.id);
  }, [element.id, setSelectedElementId]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingElementId(element.id);
  }, [element.id, setEditingElementId]);

  const handleResizeStart = useCallback((e: React.MouseEvent, dir: HandleDirection) => {
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
      rafId: null,
      lastMouseX: e.clientX,
      lastMouseY: e.clientY,
    };
  }, [element.position]);

  useEffect(() => {
    const flushResizeFrame = () => {
      const r = resizeRef.current;
      if (!r) return;
      r.rafId = null;

      const zoom = canvasTransformState.zoom || 1;
      const dx = (r.lastMouseX - r.startMouseX) / zoom;
      const dy = (r.lastMouseY - r.startMouseY) / zoom;
      const dw = Math.round(dx / GRID_UNIT);
      const dh = Math.round(dy / GRID_UNIT);

      let newW = r.origW;
      let newH = r.origH;
      let newX = r.origX;
      let newY = r.origY;

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

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      r.lastMouseX = e.clientX;
      r.lastMouseY = e.clientY;
      if (r.rafId === null) {
        r.rafId = window.requestAnimationFrame(flushResizeFrame);
      }
    };

    const handleGlobalMouseUp = () => {
      const r = resizeRef.current;
      if (!r) return;
      if (r.rafId !== null) {
        window.cancelAnimationFrame(r.rafId);
        flushResizeFrame();
      }
      resizeRef.current = null;
      onPositionChange?.(element.id);
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [element.id, element.position, onPositionChange, updateElement]);

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
      onDoubleClick={handleDoubleClick}
    >
      {children}

      {isSelected && !isEditing && (
        <>
          <div data-resize-handle="nw" style={{ ...handleStyle, top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nwse-resize" }} onMouseDown={(e) => handleResizeStart(e, "nw")} />
          <div data-resize-handle="n" style={{ ...handleStyle, top: -HANDLE_SIZE / 2, left: "calc(50% - 4px)", cursor: "ns-resize" }} onMouseDown={(e) => handleResizeStart(e, "n")} />
          <div data-resize-handle="ne" style={{ ...handleStyle, top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nesw-resize" }} onMouseDown={(e) => handleResizeStart(e, "ne")} />
          <div data-resize-handle="e" style={{ ...handleStyle, top: "calc(50% - 4px)", right: -HANDLE_SIZE / 2, cursor: "ew-resize" }} onMouseDown={(e) => handleResizeStart(e, "e")} />
          <div data-resize-handle="se" style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nwse-resize" }} onMouseDown={(e) => handleResizeStart(e, "se")} />
          <div data-resize-handle="s" style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, left: "calc(50% - 4px)", cursor: "ns-resize" }} onMouseDown={(e) => handleResizeStart(e, "s")} />
          <div data-resize-handle="sw" style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nesw-resize" }} onMouseDown={(e) => handleResizeStart(e, "sw")} />
          <div data-resize-handle="w" style={{ ...handleStyle, top: "calc(50% - 4px)", left: -HANDLE_SIZE / 2, cursor: "ew-resize" }} onMouseDown={(e) => handleResizeStart(e, "w")} />
        </>
      )}
    </div>
  );
};
