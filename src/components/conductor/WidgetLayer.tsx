"use client";

import React, { useMemo, useCallback, useRef } from "react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useConductorStore } from "@/stores/conductor-store";
import { widgetRegistry } from "@/conductor/widgets/registry";
import { WidgetShell } from "./WidgetShell";
import type { ConductorWidget, CanvasElement } from "@/types/conductor";
import { executeAction } from "@/lib/conductor-ipc";

const COLS = { lg: 12, md: 8, sm: 4 };
const BREAKPOINTS = { lg: 1200, md: 800, sm: 480 };
const DEBOUNCE_MS = 600;

interface WidgetLayerProps {
  elements: CanvasElement[];
  readOnly: boolean;
}

function elementToConductorWidget(el: CanvasElement): ConductorWidget {
  const widgetType = el.elementKind.replace("widget/", "");
  const def = widgetRegistry.get(widgetType);

  let widgetData: Record<string, unknown> = {};
  let widgetConfig: Record<string, unknown> = el.config;

  if (def) {
    const configKeySet = new Set(Object.keys(def.defaultConfig));
    const data: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(el.config)) {
      if (configKeySet.has(key)) {
        config[key] = value;
      } else {
        data[key] = value;
      }
    }

    widgetData = Object.keys(data).length > 0 ? data : (def.defaultData as Record<string, unknown>);
    widgetConfig = { ...def.defaultConfig, ...config };
  }

  return {
    id: el.id,
    canvasId: el.canvasId,
    kind: "builtin",
    type: widgetType,
    position: {
      x: el.position.x,
      y: el.position.y,
      w: el.position.w,
      h: el.position.h,
    },
    config: widgetConfig,
    data: widgetData,
    dataVersion: el.dataVersion,
    sourceCode: el.sourceCode,
    state: el.state === "error" ? "error" : el.state === "loading" ? "loading" : "idle",
    permissions: {
      agentCanRead: el.permissions.agentCanRead,
      agentCanWrite: el.permissions.agentCanWrite,
      agentCanDelete: el.permissions.agentCanDelete,
    },
    createdAt: el.createdAt,
    updatedAt: el.updatedAt,
  };
}

function elementToLayoutItem(el: CanvasElement): LayoutItem {
  return {
    i: el.id,
    x: el.position.x,
    y: el.position.y,
    w: el.position.w,
    h: el.position.h,
    minW: 2,
    minH: 2,
    isDraggable: !false,
    isResizable: !false,
  };
}

export const WidgetLayer: React.FC<WidgetLayerProps> = ({ elements, readOnly }) => {
  const { activeCanvasId, updateElement } = useConductorStore();
  const { width, containerRef } = useContainerWidth();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const widgets = useMemo(
    () => elements.map((el) => elementToConductorWidget(el)),
    [elements]
  );

  const layout = useMemo<LayoutItem[]>(
    () => elements.map((el) => elementToLayoutItem(el)),
    [elements]
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
      {widgets.map((widget) => (
        <div key={widget.id}>
          <WidgetShell widget={widget} />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
};