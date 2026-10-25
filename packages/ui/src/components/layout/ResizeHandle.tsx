"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * Which edge of the boundary the handle sits on.
 *
 * - `left` / `right`: a vertical separator line; the pane next to it grows
 *   horizontally. `left` means the handle is on the pane's LEFT edge, so the
 *   pane it resizes is the one on its right.
 * - `top` / `bottom`: a horizontal separator line; the pane next to it grows
 *   vertically. `top` means the handle is on the pane's TOP edge, so the pane
 *   it resizes is the one below it.
 */
export type ResizeHandleSide = "left" | "right" | "top" | "bottom";

interface ResizeHandleProps {
  side?: ResizeHandleSide;
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /**
   * Current size of the pane the handle resizes, exposed via aria-valuenow
   * and used for keyboard steps. Pixels, along the separator's axis.
   */
  width?: number;
  /** Lower bound for keyboard resizing / aria-valuemin. */
  minWidth?: number;
  /** Upper bound for keyboard resizing / aria-valuemax. `undefined` = unbounded. */
  maxWidth?: number;
  /**
   * Absolute width request from keyboard interaction (arrow keys, Home/End).
   * Receives an already-unclamped target; the caller applies its own bounds.
   */
  onWidthRequest?: (width: number) => void;
  /** Restore the page's default width (double-click / Enter). */
  onReset?: () => void;
  /** Accessible name for the separator. */
  label?: string;
}

/** Keyboard resize step in px; Shift multiplies it. */
const KEY_STEP_PX = 16;

export function ResizeHandle({
  side = "left",
  onResize,
  onResizeStart,
  onResizeEnd,
  width,
  minWidth,
  maxWidth,
  onWidthRequest,
  onReset,
  label,
}: ResizeHandleProps) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const isDragging = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const pendingDeltaRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);

  useEffect(() => {
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
  }, [onResize, onResizeEnd]);

  /**
   * A `left` / `right` handle moves along x, a `top` / `bottom` handle along
   * y. `primaryOnRight` (resp. `primaryBelow`) tells which side of the handle
   * the resized pane sits on, which decides the sign of the reported delta.
   */
  const horizontal = side === "left" || side === "right";
  const primaryOnRight = side === "left" || side === "top";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      setDragging(true);
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      pendingDeltaRef.current = 0;
      onResizeStart?.();
      document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [horizontal, onResizeStart]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      pendingDeltaRef.current = horizontal
        ? (primaryOnRight ? e.clientX - startXRef.current : startXRef.current - e.clientX)
        : (primaryOnRight ? e.clientY - startYRef.current : startYRef.current - e.clientY);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        onResizeRef.current(pendingDeltaRef.current);
      });
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragging(false);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        onResizeRef.current(pendingDeltaRef.current);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEndRef.current?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [horizontal, primaryOnRight]);

  const requestWidth = useCallback(
    (target: number) => {
      if (!onWidthRequest || typeof width !== "number") return;
      const clampedTarget =
        typeof minWidth === "number" ? Math.max(minWidth, target) : target;
      onWidthRequest(clampedTarget);
    },
    [minWidth, onWidthRequest, width]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onWidthRequest || typeof width !== "number") return;
      // The arrow that moves the boundary edge AWAY from the resized pane
      // grows that pane.
      const growKey = horizontal ? "ArrowLeft" : side === "top" ? "ArrowUp" : "ArrowDown";
      const shrinkKey = horizontal ? "ArrowRight" : side === "top" ? "ArrowDown" : "ArrowUp";
      switch (e.key) {
        case growKey:
          e.preventDefault();
          requestWidth(width + KEY_STEP_PX * (e.shiftKey ? 4 : 1));
          break;
        case shrinkKey:
          e.preventDefault();
          requestWidth(width - KEY_STEP_PX * (e.shiftKey ? 4 : 1));
          break;
        case "Home":
          if (typeof minWidth === "number") {
            e.preventDefault();
            requestWidth(minWidth);
          }
          break;
        case "End":
          if (typeof maxWidth === "number") {
            e.preventDefault();
            requestWidth(maxWidth);
          }
          break;
        case "Enter":
        case " ":
          if (onReset) {
            e.preventDefault();
            onReset();
          }
          break;
        default:
          break;
      }
    },
    [horizontal, maxWidth, minWidth, onReset, onWidthRequest, requestWidth, side, width]
  );

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      onKeyDown={onWidthRequest ? handleKeyDown : undefined}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={typeof width === "number" ? Math.round(width) : undefined}
      aria-valuemin={minWidth}
      aria-valuemax={typeof maxWidth === "number" ? Math.round(maxWidth) : undefined}
      tabIndex={onWidthRequest ? 0 : undefined}
      data-resizing={dragging ? "true" : undefined}
    >
      <div className="resize-handle-bar" />
      {dragging && <div className="resize-handle-badge">{t("panel.resizeBadge")}</div>}
    </div>
  );
}
