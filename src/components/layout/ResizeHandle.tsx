"use client";

import { useCallback, useRef, useEffect } from "react";

interface ResizeHandleProps {
  side: "left" | "right";
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Current panel width, exposed via aria-valuenow and used for keyboard steps. */
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
  side,
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
  const isDragging = useRef(false);
  const startXRef = useRef(0);
  const pendingDeltaRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);

  useEffect(() => {
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
  }, [onResize, onResizeEnd]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startXRef.current = e.clientX;
      pendingDeltaRef.current = 0;
      onResizeStart?.();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onResizeStart]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      pendingDeltaRef.current =
        side === "left"
          ? e.clientX - startXRef.current
          : startXRef.current - e.clientX;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        onResizeRef.current(pendingDeltaRef.current);
      });
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
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
  }, [side]);

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
      switch (e.key) {
        case "ArrowLeft":
          // Widen (the panel sits to the right of this handle).
          e.preventDefault();
          requestWidth(width + KEY_STEP_PX * (e.shiftKey ? 4 : 1));
          break;
        case "ArrowRight":
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
    [maxWidth, minWidth, onReset, onWidthRequest, requestWidth, width]
  );

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      onKeyDown={onWidthRequest ? handleKeyDown : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={typeof width === "number" ? Math.round(width) : undefined}
      aria-valuemin={minWidth}
      aria-valuemax={typeof maxWidth === "number" ? Math.round(maxWidth) : undefined}
      tabIndex={onWidthRequest ? 0 : undefined}
    >
      <div className="resize-handle-bar" />
    </div>
  );
}
