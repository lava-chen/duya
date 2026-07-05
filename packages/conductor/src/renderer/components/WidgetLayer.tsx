"use client";

import React, { useMemo, useCallback, useRef } from "react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useConductorStore } from "..//stores/conductor-store";
import { WidgetElement } from "..//elements/WidgetElement";
import type { CanvasElement } from "..//types/conductor";
import { executeAction } from "..//ipc/conductor-ipc";

const COLS = { lg: 12, md: 8, sm: 4 };
const BREAKPOINTS = { lg: 1200, md: 800, sm: 480 };
const DEBOUNCE_MS = 600;

interface WidgetLayerProps {
  elements: CanvasElement[];
  readOnly: boolean;
}

function elementToLayoutItem(el: CanvasElement, readOnly: boolean): LayoutItem {
  return {
    i: el.id,
    x: el.position.x,
    y: el.position.y,
    w: el.position.w,
    h: el.position.h,
    minW: 2,
    minH: 2,
    isDraggable: !readOnly,
    isResizable: !readOnly,
  };
}

export const WidgetLayer: React.FC<WidgetLayerProps> = ({ elements, readOnly }) => {
  const { activeCanvasId } = useConductorStore();
  const { width, containerRef } = useContainerWidth();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const layout = useMemo<LayoutItem[]>(
    () => elements.map((el) => elementToLayoutItem(el, readOnly)),
    [elements, readOnly]
  );

  const debouncedSave = useCallback(
    (elementId: string, action: string, pos: { x: number; y: number; w: number; h: number }) => {
      if (!activeCanvasId) return;

      const existing = debounceTimers.current.get(elementId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        executeAction({
          action: action as "element.move",
          elementId,
          canvasId: activeCanvasId,
          position: { ...pos, zIndex: 0, rotation: 0 },
        }).catch(() => {});
        debounceTimers.current.delete(elementId);
      }, DEBOUNCE_MS);

      debounceTimers.current.set(elementId, timer);
    },
    [activeCanvasId]
  );

  const handleLayoutChange = useCallback(
    (_newLayout: Layout) => {
      // Intentionally empty — syncing position back to the store here
      // creates an infinite loop: store update → re-render → new layout prop →
      // react-grid-layout fires onLayoutChange again.
      // Positions are synced in onDragStop / onResizeStop instead.
    },
    []
  );

  const handleDragStop = useCallback(
    (_layout: Layout, _oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!activeCanvasId || !newItem) return;
      debouncedSave(newItem.i, "element.move", {
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
      debouncedSave(newItem.i, "element.move", {
        x: newItem.x,
        y: newItem.y,
        w: newItem.w,
        h: newItem.h,
      });
    },
    [activeCanvasId, debouncedSave]
  );

  return (
    <div ref={containerRef} className="w-full h-full">
      <ResponsiveGridLayout
        className="layout widget-layer"
        width={Math.max(width, 1200)}
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
        {elements.map((el) => (
          <div key={el.id}>
            <WidgetElement element={el} readOnly={readOnly} />
          </div>
        ))}
      </ResponsiveGridLayout>
    </div>
  );
};