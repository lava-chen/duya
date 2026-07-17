"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { X, DotsSixVertical } from "@phosphor-icons/react";
import type { CanvasElement, CanvasPosition } from "..//types/conductor";
import { canvasTransformState } from "./CanvasArea";
import { GRID_PX } from "../domain/canvas/units";
import { useConductorStore } from "../stores/conductor-store";
import { CapsuleMoreMenu, CapsuleToolbar } from "./toolbar/CapsuleToolbar";
import { useElementLock } from "./toolbar/useElementLock";

interface ElementChromeProps {
  element: CanvasElement;
  label: string;
  readOnly: boolean;
  state?: string;
  selected?: boolean;
  variant?: "default" | "minimal";
  onDelete?: () => void;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  children: React.ReactNode;
}

const MIN_SIZE_GRID = 1;

export const ElementChrome: React.FC<ElementChromeProps> = ({
  element,
  label,
  readOnly,
  state,
  selected,
  variant = "default",
  onDelete,
  onPositionChange,
  children,
}) => {
  const { locked, toggleLocked } = useElementLock(element);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const isMinimal = variant === "minimal";
  const resizeRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    origW: number;
    origH: number;
    rafId: number | null;
    lastMouseX: number;
    lastMouseY: number;
  } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      origW: element.position.w,
      origH: element.position.h,
      rafId: null,
      lastMouseX: e.clientX,
      lastMouseY: e.clientY,
    };
  }, [element.position, locked]);

  useEffect(() => {
    const flushResizeFrame = () => {
      const r = resizeRef.current;
      if (!r) return;
      r.rafId = null;

      const zoom = canvasTransformState.zoom || 1;
      const dx = (r.lastMouseX - r.startMouseX) / zoom;
      const dy = (r.lastMouseY - r.startMouseY) / zoom;
      const dw = dx / GRID_PX;
      const dh = dy / GRID_PX;

      const newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
      const newH = Math.max(MIN_SIZE_GRID, r.origH + dh);

      onPositionChange?.(element.id, {
        ...element.position,
        w: newW,
        h: newH,
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
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [element.id, element.position, onPositionChange]);

  const showResize = !readOnly && !locked;
  const selectionToolbar = selected && !readOnly ? (
    <CapsuleToolbar>
      <CapsuleMoreMenu
        title="More element actions"
        items={[
          { label: locked ? "Unlock position" : "Lock position", onSelect: toggleLocked },
          { label: "Close toolbar", onSelect: () => setSelectedElementId(null) },
          ...(onDelete
            ? [{ label: "Delete element", onSelect: onDelete, tone: "danger" as const }]
            : []),
        ]}
      />
    </CapsuleToolbar>
  ) : null;

  if (isMinimal) {
    return (
      <div className="relative w-full h-full group">
        {selectionToolbar}
        {/* Transparent drag frame. It is invisible by default so the widget
            looks borderless, but it becomes visible on hover to signal that
            the edge can be used to drag/resize the widget without covering
            the interactive content. */}
        {!readOnly && (
          <div
            className="absolute inset-0 border-[6px] border-transparent rounded-xl transition-colors duration-200 group-hover:border-[var(--accent)]/25 pointer-events-auto z-10"
            style={{ boxSizing: "border-box" }}
          />
        )}
        <div className="absolute inset-[6px] overflow-hidden rounded-lg">
          {children}
        </div>
        {showResize && (
          <div
            data-resize-handle="se"
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-20 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{
              background: "linear-gradient(135deg, transparent 50%, var(--accent) 50%, transparent 75%)",
            }}
            onMouseDown={handleResizeStart}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-visible">
      {selectionToolbar}
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--main-bg)] shadow-sm transition-all duration-300 hover:shadow-md group">
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0"
          style={{ cursor: locked ? "default" : "grab" }}
        >
        <div className="flex items-center gap-2 min-w-0">
          <DotsSixVertical size={12} className="text-[var(--muted)] flex-shrink-0" />
          <span className="text-xs font-medium text-[var(--text)] truncate">
            {label}
          </span>
          {state === "loading" && (
            <span className="w-3 h-3 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
          )}
        </div>
        {!readOnly && onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--muted)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] transition-colors"
            style={{ opacity: 0 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
          >
            <X size={12} />
          </button>
        )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {children}
        </div>
        {showResize && (
          <div
            data-resize-handle="se"
            className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize z-10"
            style={{
              background: "linear-gradient(135deg, transparent 50%, var(--border) 50%, transparent 75%)",
            }}
            onMouseDown={handleResizeStart}
          />
        )}
      </div>
    </div>
  );
};
