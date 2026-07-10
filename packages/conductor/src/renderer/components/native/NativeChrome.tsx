"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { canvasTransformState } from "../CanvasArea";
import { GRID_PX } from "../../domain/canvas/units";
import { PencilIcon, TrashIcon } from "@/components/icons";
import { executeAction } from "../../ipc/conductor-ipc";

type HandleDirection = "nw" | "ne" | "se" | "sw";

const HANDLE_SIZE = 8;
const MIN_SIZE_GRID = 1;

interface NativeChromeProps {
  element: CanvasElement;
  children: React.ReactNode;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
}

export const NativeChrome: React.FC<NativeChromeProps> = ({ element, children, onPositionChange }) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const removeElement = useConductorStore((state) => state.removeElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);

  const isSelected = selectedElementId === element.id || selectedElementIds.includes(element.id);
  const isEditing = editingElementId === element.id;

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    removeElement(element.id);
    if (activeCanvasId) {
      executeAction({
        action: "element.delete",
        elementId: element.id,
        canvasId: activeCanvasId,
      }).catch(() => {});
    }
  }, [activeCanvasId, element.id, removeElement]);

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

      switch (r.dir as HandleDirection | "n" | "e" | "s" | "w") {
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

      // Aspect-ratio lock for resizeMode='ratio' (Shift toggles free).
      const resizeMode = element.metadata?.resizeMode ?? 'free';
      const shiftHeld = (window.event as MouseEvent | null)?.shiftKey ?? false;
      if (resizeMode === 'ratio' && !shiftHeld && (r.dir === 'nw' || r.dir === 'ne' || r.dir === 'se' || r.dir === 'sw')) {
        const origRatio = r.origW / r.origH;
        const newRatio = newW / newH;
        if (Math.abs(newRatio - origRatio) > 0.001) {
          // Adjust the smaller dimension to preserve ratio.
          if (newW / origRatio <= newH) {
            newH = newW / origRatio;
          } else {
            newW = newH * origRatio;
          }
          // For nw/sw: y was computed from origH - newH; recompute.
          if (r.dir === 'nw' || r.dir === 'sw') {
            newY = r.origY + r.origH - newH;
          }
          // For nw/ne: x was computed from origW - newW; recompute.
          if (r.dir === 'nw' || r.dir === 'ne') {
            newX = r.origX + r.origW - newW;
          }
        }
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
      let finalPosition: CanvasPosition | undefined;
      if (el) {
        const snappedW = Math.max(MIN_SIZE_GRID, Math.round(el.position.w));
        const snappedH = Math.max(MIN_SIZE_GRID, Math.round(el.position.h));
        const snappedX = Math.round(el.position.x);
        const snappedY = Math.round(el.position.y);
        finalPosition = { ...el.position, x: snappedX, y: snappedY, w: snappedW, h: snappedH };
        updateElement(element.id, { position: finalPosition });
      }
      resizeRef.current = null;
      if (finalPosition) {
        onPositionChange?.(element.id, finalPosition);
      }
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
    width: 8,
    height: 8,
    background: "var(--canvas-bg, #fff)",
    border: "1px solid var(--conductor-accent)",
    borderRadius: 2,
    zIndex: 10,
    pointerEvents: "auto",
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
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

      {isSelected && !isEditing && element.elementKind === "native/sticky" && (
        <div
          style={{
            position: "absolute",
            top: -46,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: "6px 10px",
            background: "rgba(40, 44, 52, 0.98)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 22,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.2)",
            pointerEvents: "auto",
            zIndex: 20,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditingElementId(element.id);
            }}
            title="Edit"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: "none",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
              transition: "background var(--motion-duration-micro) var(--motion-smooth)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <PencilIcon size={16} />
          </button>
          <div
            style={{
              width: 1,
              height: 16,
              background: "rgba(255,255,255,0.15)",
              margin: "0 4px",
            }}
          />
          <button
            type="button"
            onClick={handleDelete}
            title="Delete"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: "none",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
              transition: "background var(--motion-duration-micro) var(--motion-smooth)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <TrashIcon size={16} />
          </button>
        </div>
      )}

      {isSelected && !isEditing && element.metadata?.resizeMode !== 'fixed' && (
        <>
          <div
            data-resize-handle="nw"
            className="conductor-resize-handle nw"
            style={{ ...handleStyle, top: -4, left: -4, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "nw")}
          />
          <div
            data-resize-handle="ne"
            className="conductor-resize-handle ne"
            style={{ ...handleStyle, top: -4, right: -4, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "ne")}
          />
          <div
            data-resize-handle="se"
            className="conductor-resize-handle se"
            style={{ ...handleStyle, bottom: -4, right: -4, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "se")}
          />
          <div
            data-resize-handle="sw"
            className="conductor-resize-handle sw"
            style={{ ...handleStyle, bottom: -4, left: -4, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "sw")}
          />
        </>
      )}
    </div>
  );
};
