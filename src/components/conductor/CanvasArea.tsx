"use client";

import React, { useCallback, useRef, useEffect, useState } from "react";
import type { CanvasElement, CanvasPosition } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { FreeformLayer } from "./FreeformLayer";
import { WidgetLayer } from "./WidgetLayer";
import { ConnectorOverlay } from "./ConnectorOverlay";

const MIN_CANVAS_WIDTH = 1800;
const MIN_CANVAS_HEIGHT = 1200;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

function isWidgetKind(element: CanvasElement): boolean {
  return element.elementKind.startsWith("widget/");
}

function isConnectorElement(element: CanvasElement): boolean {
  return element.elementKind === "shape/connector";
}

interface CanvasAreaProps {
  elements: CanvasElement[];
  readOnly: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
}

export const CanvasArea: React.FC<CanvasAreaProps> = ({
  elements,
  readOnly,
  onPositionChange,
  onDeleteElement,
}) => {
  const { canvasZoom, setCanvasZoom } = useConductorStore();
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const hasCenteredRef = useRef(false);

  const hasFreeformElements = elements.some(
    (el) => !isWidgetKind(el) && !isConnectorElement(el)
  );

  const widgetElements = elements.filter((el) => isWidgetKind(el));
  const freeformElements = elements.filter(
    (el) => !isWidgetKind(el) && !isConnectorElement(el)
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((canvasZoom + delta).toFixed(2))));
    setCanvasZoom(newZoom);
  }, [canvasZoom, setCanvasZoom]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".react-grid-item")) return;
    if (target.closest('[onMouseDown]')) return;
    const host = scrollHostRef.current;
    if (!host) return;
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: host.scrollLeft,
      top: host.scrollTop,
    };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isPanning || !panStartRef.current) return;
      const host = scrollHostRef.current;
      if (!host) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      host.scrollLeft = panStartRef.current.left - dx;
      host.scrollTop = panStartRef.current.top - dy;
    },
    [isPanning]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  // Center canvas on initial load
  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host || hasCenteredRef.current) return;
    
    const containerWidth = host.clientWidth;
    const containerHeight = host.clientHeight;
    const scrollLeft = (MIN_CANVAS_WIDTH - containerWidth) / 2;
    const scrollTop = (MIN_CANVAS_HEIGHT - containerHeight) / 2;
    
    host.scrollLeft = Math.max(0, scrollLeft);
    host.scrollTop = Math.max(0, scrollTop);
    hasCenteredRef.current = true;
  }, []);

  return (
    <div
      className="h-full overflow-auto canvas-area"
      ref={scrollHostRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isPanning ? "grabbing" : "default" }}
    >
      <div
        className="relative"
        style={{
          width: MIN_CANVAS_WIDTH,
          minHeight: MIN_CANVAS_HEIGHT,
          zoom: canvasZoom,
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      >
        {elements.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-[var(--muted)] text-sm">This canvas is empty</p>
          </div>
        )}

        {hasFreeformElements ? (
          <>
            <div style={{ zIndex: 0, position: "relative" }}>
              <WidgetLayer
                elements={widgetElements}
                readOnly={readOnly}
              />
            </div>
            <div style={{ zIndex: 1, position: "absolute", inset: 0 }}>
              <FreeformLayer
                elements={freeformElements}
                readOnly={readOnly}
                onPositionChange={onPositionChange}
                onDeleteElement={onDeleteElement}
              />
            </div>
            <ConnectorOverlay elements={elements} />
          </>
        ) : (
          <WidgetLayer
            elements={widgetElements}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  );
};