"use client";

import React, { useMemo, useCallback, useRef } from "react";
import { ResponsiveGridLayout } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useConductorStore } from "..//stores/conductor-store";
import { WidgetElement } from "..//elements/WidgetElement";
import type { CanvasElement } from "..//types/conductor";
import { executeAction } from "..//ipc/conductor-ipc";
import { GRID_PX } from "../domain/canvas/units";
import { canvasTransformState } from "./CanvasArea";

const CANVAS_WIDTH_GRID = 40;
const CANVAS_HEIGHT_GRID = 30;
const COLS = { lg: CANVAS_WIDTH_GRID, md: CANVAS_WIDTH_GRID, sm: CANVAS_WIDTH_GRID };
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

function createZoomStrategy(zoom: number) {
  return {
    type: "transform" as const,
    scale: zoom,
    calcStyle(pos: { left: number; top: number; width: number; height: number }) {
      return {
        transform: `translate3d(${pos.left}px, ${pos.top}px, 0)`,
        width: `${pos.width}px`,
        height: `${pos.height}px`,
        position: "absolute" as const,
      };
    },
    calcDragPosition(clientX: number, clientY: number, offsetX: number, offsetY: number) {
      return {
        left: (clientX - offsetX) / zoom,
        top: (clientY - offsetY) / zoom,
      };
    },
  };
}

export const WidgetLayer: React.FC<WidgetLayerProps> = ({ elements, readOnly }) => {
  const { activeCanvasId, updateElement } = useConductorStore();
  const layerRef = useRef<HTMLDivElement>(null);
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Use the module-level transform state updated synchronously in
  // CanvasArea.applyTransform instead of the debounced store value.
  // This keeps drag/resize tracking accurate while zoom is changing.
  const positionStrategy = createZoomStrategy(canvasTransformState.zoom);

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
      // Sync the local store immediately so the widget does not visually
      // snap back to its old position while waiting for the 600ms debounced
      // IPC round-trip. Without this, the store still holds the pre-drag
      // position and the next render pulls the widget back, only to jump
      // forward again once the backend confirms — the "弹回再跳" symptom.
      updateElement(newItem.i, {
        position: { x: newItem.x, y: newItem.y, w: newItem.w, h: newItem.h, zIndex: 0, rotation: 0 },
        updatedAt: Date.now(),
      });
      debouncedSave(newItem.i, "element.move", {
        x: newItem.x,
        y: newItem.y,
        w: newItem.w,
        h: newItem.h,
      });
    },
    [activeCanvasId, debouncedSave, updateElement]
  );

  const handleResizeStop = useCallback(
    (_layout: Layout, _oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!activeCanvasId || !newItem) return;
      // Same immediate-sync rationale as handleDragStop.
      updateElement(newItem.i, {
        position: { x: newItem.x, y: newItem.y, w: newItem.w, h: newItem.h, zIndex: 0, rotation: 0 },
        updatedAt: Date.now(),
      });
      debouncedSave(newItem.i, "element.move", {
        x: newItem.x,
        y: newItem.y,
        w: newItem.w,
        h: newItem.h,
      });
    },
    [activeCanvasId, debouncedSave, updateElement]
  );

  return (
    <div ref={layerRef} className="w-full h-full">
      <ResponsiveGridLayout
        className="layout widget-layer"
        // The canvas model stores position.{x,y,w,h} in grid units (1 unit = GRID_PX
        // px). Match RGL's grid 1:1 with the canvas grid so the red drag placeholder
        // and resize preview have the same size and position as the actual widget.
        width={CANVAS_WIDTH_GRID * GRID_PX}
        layouts={{ lg: layout }}
        breakpoints={BREAKPOINTS}
        cols={COLS}
        rowHeight={GRID_PX}
        onLayoutChange={handleLayoutChange}
        onDragStop={handleDragStop}
        onResizeStop={handleResizeStop}
        margin={[0, 0]}
        containerPadding={[0, 0]}
        positionStrategy={positionStrategy}
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