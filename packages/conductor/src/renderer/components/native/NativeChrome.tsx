"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { canvasTransformState } from "../CanvasArea";
import { GRID_PX } from "../../domain/canvas/units";

type HandleDirection = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_SIZE = 8;
const MIN_SIZE_GRID = 1;

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
      // Use float grid units for smooth live resize; snap on commit.
      const dw = dx / GRID_PX;
      const dh = dy / GRID_PX;

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
      // Snap final size/position to whole grid units on commit so the
      // layout stays tidy after a smooth live resize.
      const el = useConductorStore.getState().elements.find((e) => e.id === element.id);
      if (el) {
        const snappedW = Math.max(MIN_SIZE_GRID, Math.round(el.position.w));
        const snappedH = Math.max(MIN_SIZE_GRID, Math.round(el.position.h));
        const snappedX = Math.round(el.position.x);
        const snappedY = Math.round(el.position.y);
        updateElement(element.id, {
          position: { ...el.position, x: snappedX, y: snappedY, w: snappedW, h: snappedH },
        });
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
    width: 10,
    height: 10,
    background: "var(--conductor-accent)",
    border: "2px solid var(--canvas-bg)",
    borderRadius: "50%",
    zIndex: 10,
    pointerEvents: "auto",
    transition: "transform var(--motion-duration-micro) var(--motion-spring)",
  };

  return (
    <div
      className="native-chrome"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        outline: isSelected ? "2px solid var(--conductor-accent)" : "none",
        outlineOffset: isSelected ? 2 : 0,
        borderRadius: "var(--radius-element)",
        cursor: isEditing ? "text" : "default",
        boxShadow: isSelected ? "0 0 0 4px var(--conductor-accent-soft)" : "none",
        transition: "outline var(--motion-duration-micro) var(--motion-smooth), box-shadow var(--motion-duration-micro) var(--motion-smooth)",
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {children}

      {isSelected && !isEditing && (
        <>
          <div data-resize-handle="nw" className="conductor-resize-handle nw" style={{ ...handleStyle, top: -5, left: -5, cursor: "nwse-resize" }} onMouseDown={(e) => handleResizeStart(e, "nw")} />
          <div data-resize-handle="n" className="conductor-resize-handle n" style={{ ...handleStyle, top: -5, left: "calc(50% - 5px)", cursor: "ns-resize" }} onMouseDown={(e) => handleResizeStart(e, "n")} />
          <div data-resize-handle="ne" className="conductor-resize-handle ne" style={{ ...handleStyle, top: -5, right: -5, cursor: "nesw-resize" }} onMouseDown={(e) => handleResizeStart(e, "ne")} />
          <div data-resize-handle="e" className="conductor-resize-handle e" style={{ ...handleStyle, top: "calc(50% - 5px)", right: -5, cursor: "ew-resize" }} onMouseDown={(e) => handleResizeStart(e, "e")} />
          <div data-resize-handle="se" className="conductor-resize-handle se" style={{ ...handleStyle, bottom: -5, right: -5, cursor: "nwse-resize" }} onMouseDown={(e) => handleResizeStart(e, "se")} />
          <div data-resize-handle="s" className="conductor-resize-handle s" style={{ ...handleStyle, bottom: -5, left: "calc(50% - 5px)", cursor: "ns-resize" }} onMouseDown={(e) => handleResizeStart(e, "s")} />
          <div data-resize-handle="sw" className="conductor-resize-handle sw" style={{ ...handleStyle, bottom: -5, left: -5, cursor: "nesw-resize" }} onMouseDown={(e) => handleResizeStart(e, "sw")} />
          <div data-resize-handle="w" className="conductor-resize-handle w" style={{ ...handleStyle, top: "calc(50% - 5px)", left: -5, cursor: "ew-resize" }} onMouseDown={(e) => handleResizeStart(e, "w")} />
        </>
      )}
    </div>
  );
};
