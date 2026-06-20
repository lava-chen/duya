"use client";

import { useCallback, useRef, useEffect } from "react";

interface ResizeHandleProps {
  side: "left" | "right";
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function ResizeHandle({ side, onResize, onResizeStart, onResizeEnd }: ResizeHandleProps) {
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

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      onMouseDown={handleMouseDown}
    >
      <div className="resize-handle-bar" />
    </div>
  );
}
