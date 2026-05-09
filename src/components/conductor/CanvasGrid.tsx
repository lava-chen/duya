"use client";

import { useMemo, useCallback, useRef, useState } from "react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useConductorStore } from "@/stores/conductor-store";
import { WidgetShell } from "./WidgetShell";
import type { ConductorWidget, Position } from "@/types/conductor";
import { executeAction } from "@/lib/conductor-ipc";

const COLS = { lg: 12, md: 8, sm: 4 };
const BREAKPOINTS = { lg: 1200, md: 800, sm: 480 };
const DEBOUNCE_MS = 600;
const MIN_CANVAS_WIDTH = 1800;
const MIN_CANVAS_HEIGHT = 1200;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

function widgetToLayoutItem(w: ConductorWidget, editMode: boolean): LayoutItem {
  return {
    i: w.id,
    x: w.position.x,
    y: w.position.y,
    w: w.position.w,
    h: w.position.h,
    minW: 2,
    minH: 2,
    isDraggable: editMode,
    isResizable: editMode,
  };
}

export function CanvasGrid() {
  const { widgets, editMode, activeCanvasId, updateWidget } = useConductorStore();
  const { width, containerRef } = useContainerWidth();
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);

  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const layout = useMemo<LayoutItem[]>(
    () => widgets.map((w) => widgetToLayoutItem(w, editMode)),
    [widgets, editMode]
  );

  const debouncedSave = useCallback(
    (widgetId: string, action: string, position: Position) => {
      if (!activeCanvasId) return;

      const existing = debounceTimers.current.get(widgetId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        executeAction({
          action: action as "widget.move" | "widget.resize",
          widgetId,
          canvasId: activeCanvasId,
          position,
        }).catch(() => {});
        debounceTimers.current.delete(widgetId);
      }, DEBOUNCE_MS);

      debounceTimers.current.set(widgetId, timer);
    },
    [activeCanvasId]
  );

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      if (!activeCanvasId || !editMode) return;

      for (const item of newLayout) {
        const widget = widgets.find((w) => w.id === item.i);
        if (!widget) continue;

        const position: Position = {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        };

        if (
          position.x !== widget.position.x ||
          position.y !== widget.position.y ||
          position.w !== widget.position.w ||
          position.h !== widget.position.h
        ) {
          updateWidget(item.i, {
            position,
            updatedAt: Date.now(),
          });
        }
      }
    },
    [activeCanvasId, editMode, widgets, updateWidget]
  );

  const handleDragStop = useCallback(
    (_layout: Layout, _oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!activeCanvasId || !newItem) return;

      debouncedSave(newItem.i, "widget.move", {
        x: newItem.x,
        y: newItem.y,
        w: newItem.w,
        h: newItem.h,
      });
    },
    [activeCanvasId, debouncedSave]
  );

  const handleResizeStop = useCallback(
    (_layout: Layout, _oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!activeCanvasId || !newItem) return;

      debouncedSave(newItem.i, "widget.resize", {
        x: newItem.x,
        y: newItem.y,
        w: newItem.w,
        h: newItem.h,
      });
    },
    [activeCanvasId, debouncedSave]
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((prev + delta).toFixed(2)))));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".react-grid-item")) return;
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

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanning || !panStartRef.current) return;
    const host = scrollHostRef.current;
    if (!host) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    host.scrollLeft = panStartRef.current.left - dx;
    host.scrollTop = panStartRef.current.top - dy;
  }, [isPanning]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  return (
    <div
      className="h-full overflow-auto"
      ref={(el) => {
        containerRef.current = el;
        scrollHostRef.current = el;
      }}
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
          zoom,
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      >
        {widgets.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-[var(--muted)] text-sm">This canvas is empty</p>
          </div>
        )}

        <ResponsiveGridLayout
          className="layout"
          width={Math.max(width, MIN_CANVAS_WIDTH)}
          layouts={{ lg: layout }}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={80}
          onLayoutChange={handleLayoutChange}
          onDragStop={handleDragStop}
          onResizeStop={handleResizeStop}
          margin={[16, 16]}
          containerPadding={[16, 16]}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetShell widget={widget} />
            </div>
          ))}
        </ResponsiveGridLayout>
      </div>
    </div>
  );
}
