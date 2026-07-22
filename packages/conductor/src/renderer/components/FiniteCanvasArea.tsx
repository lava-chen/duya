"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DotsSixVertical } from "@phosphor-icons/react";
import { GridLayout, noCompactor, verticalCompactor } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useTranslation } from "@/hooks/useTranslation";
import type { CanvasElement, CanvasPosition } from "../types/conductor";
import { useConductorStore } from "../stores/conductor-store";
import { updateCanvas } from "../ipc/conductor-ipc";
import { ElementRenderer } from "./ElementRenderer";
import { canvasTransformState } from "./CanvasArea";
import {
  buildFiniteWidgetLayout,
  FINITE_GRID_COLUMNS,
  FINITE_GRID_ROW_HEIGHT,
  isFiniteFreeformElement,
  isFiniteWidgetElement,
  mergeFiniteLayoutConfig,
  type FiniteLayoutItem,
} from "../domain/canvas/finite-widget-layout";

const WIDGET_GRID_CONFIG = {
  cols: FINITE_GRID_COLUMNS,
  rowHeight: FINITE_GRID_ROW_HEIGHT,
  margin: [12, 12] as const,
  containerPadding: [0, 0] as const,
};
const FREEFORM_GRID_CONFIG = {
  cols: FINITE_GRID_COLUMNS,
  rowHeight: FINITE_GRID_ROW_HEIGHT,
  margin: [0, 0] as const,
  containerPadding: [0, 0] as const,
};
const SURFACE_MAX_WIDTH = 920;
const SURFACE_MIN_HEIGHT = 900;

interface FiniteCanvasAreaProps {
  elements: CanvasElement[];
  readOnly: boolean;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
  onDeleteElement?: (id: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function freeformLayoutItem(element: CanvasElement): LayoutItem {
  const w = clamp(Math.round(element.position.w), 1, FINITE_GRID_COLUMNS);
  const h = Math.max(1, Math.round((element.position.h * 80) / FINITE_GRID_ROW_HEIGHT));
  return {
    i: element.id,
    x: clamp(Math.round(element.position.x), 0, FINITE_GRID_COLUMNS - w),
    y: Math.max(0, Math.round((element.position.y * 80) / FINITE_GRID_ROW_HEIGHT)),
    w,
    h,
    minW: 1,
    minH: 1,
    isResizable: false,
  };
}

function layoutBottom(items: ReadonlyArray<Pick<LayoutItem, "y" | "h">>): number {
  return items.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
}

export const FiniteCanvasArea: React.FC<FiniteCanvasAreaProps> = ({
  elements,
  readOnly,
  onPositionChange,
  onDeleteElement,
}) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const persistenceSequence = useRef(0);
  const [surfaceWidth, setSurfaceWidth] = useState(720);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const canvases = useConductorStore((state) => state.canvases);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const updateCanvasInStore = useConductorStore((state) => state.updateCanvas);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const clearSelection = useConductorStore((state) => state.clearSelection);
  const setCanvasZoom = useConductorStore((state) => state.setCanvasZoom);
  const setCanvasScroll = useConductorStore((state) => state.setCanvasScroll);
  const setUiError = useConductorStore((state) => state.setUiError);

  const activeCanvas = canvases.find((canvas) => canvas.id === activeCanvasId) ?? null;
  const widgetElements = useMemo(() => elements.filter(isFiniteWidgetElement), [elements]);
  const freeformElements = useMemo(() => elements.filter(isFiniteFreeformElement), [elements]);
  const canvasOnlyCount = elements.length - widgetElements.length - freeformElements.length;
  const selectedSet = useMemo(
    () => new Set(selectedElementIds.length > 0 ? selectedElementIds : selectedElementId ? [selectedElementId] : []),
    [selectedElementId, selectedElementIds],
  );

  const widgetLayout = useMemo<FiniteLayoutItem[]>(
    () => buildFiniteWidgetLayout(widgetElements, activeCanvas?.layoutConfig),
    [activeCanvas?.layoutConfig, widgetElements],
  );
  const freeformLayout = useMemo<LayoutItem[]>(
    () => freeformElements.map(freeformLayoutItem),
    [freeformElements],
  );

  const minSurfaceHeight = Math.max(
    SURFACE_MIN_HEIGHT,
    (Math.max(layoutBottom(widgetLayout), layoutBottom(freeformLayout)) + 2) * FINITE_GRID_ROW_HEIGHT,
  );

  useEffect(() => {
    canvasTransformState.panX = 0;
    canvasTransformState.panY = 0;
    canvasTransformState.zoom = 1;
    setCanvasZoom(1);
    setCanvasScroll(0, 0);
  }, [setCanvasScroll, setCanvasZoom]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateWidth = (borderBoxWidth: number) => {
      const nextWidth = Math.min(SURFACE_MAX_WIDTH, Math.max(320, borderBoxWidth - 32));
      setSurfaceWidth((currentWidth) => (
        Math.abs(currentWidth - nextWidth) < 0.5 ? currentWidth : nextWidth
      ));
    };
    updateWidth(host.getBoundingClientRect().width);
    let pendingFrame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const borderBoxSize = entry.borderBoxSize;
      const inlineSize = Array.isArray(borderBoxSize)
        ? borderBoxSize[0]?.inlineSize
        : borderBoxSize?.inlineSize;
      const measuredWidth = inlineSize ?? entry.target.getBoundingClientRect().width;
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        updateWidth(measuredWidth);
      });
    });
    observer.observe(host, { box: "border-box" });
    return () => {
      observer.disconnect();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, []);

  const persistWidgetLayout = useCallback(async (layout: Layout) => {
    if (!activeCanvas || readOnly) return;
    const items = layout.map((item) => ({
      i: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }));
    const layoutConfig = mergeFiniteLayoutConfig(activeCanvas.layoutConfig, items);
    const sequence = ++persistenceSequence.current;
    updateCanvasInStore({ ...activeCanvas, layoutConfig, updatedAt: Date.now() });

    try {
      const updated = await updateCanvas(activeCanvas.id, { layoutConfig });
      if (updated && persistenceSequence.current === sequence) updateCanvasInStore(updated);
    } catch (error) {
      if (persistenceSequence.current === sequence) {
        updateCanvasInStore(activeCanvas);
        setUiError(`Save widget layout failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [activeCanvas, readOnly, setUiError, updateCanvasInStore]);

  const persistFreeformPosition = useCallback((newItem: LayoutItem | null) => {
    if (!newItem || readOnly) return;
    const element = freeformElements.find((candidate) => candidate.id === newItem.i);
    if (!element) return;
    const position: CanvasPosition = {
      ...element.position,
      x: newItem.x,
      y: (newItem.y * FINITE_GRID_ROW_HEIGHT) / 80,
    };
    onPositionChange?.(element.id, position);
  }, [freeformElements, onPositionChange, readOnly]);

  const handleBareSurfaceMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) clearSelection();
  }, [clearSelection]);

  return (
    <div ref={hostRef} className="finite-canvas-area canvas-area">
      <div
        className="finite-canvas-surface"
        style={{ width: surfaceWidth, minHeight: minSurfaceHeight }}
        onMouseDown={handleBareSurfaceMouseDown}
      >
        <GridLayout
          className="finite-widget-grid"
          width={surfaceWidth}
          layout={widgetLayout}
          gridConfig={WIDGET_GRID_CONFIG}
          compactor={verticalCompactor}
          dragConfig={{ enabled: !readOnly, handle: ".finite-widget-drag-handle" }}
          resizeConfig={{ enabled: !readOnly, handles: ["se"] }}
          onDragStop={(layout) => { void persistWidgetLayout(layout); }}
          onResizeStop={(layout) => { void persistWidgetLayout(layout); }}
        >
          {widgetElements.map((element) => (
            <div key={element.id} className="finite-widget-item" data-finite-widget-id={element.id}>
              <button
                type="button"
                className="finite-widget-drag-handle"
                aria-label={t("conductor.presentation.moveWidget", {
                  name: element.metadata.label || element.elementKind,
                })}
                title={t("conductor.presentation.moveWidgetHandle")}
                onClick={() => setSelectedElementId(element.id)}
              >
                <DotsSixVertical size={16} weight="bold" />
              </button>
              <ElementRenderer
                element={element}
                readOnly={readOnly}
                selected={selectedSet.has(element.id)}
                onDelete={onDeleteElement}
              />
            </div>
          ))}
        </GridLayout>

        <GridLayout
          className="finite-freeform-grid"
          width={surfaceWidth}
          layout={freeformLayout}
          gridConfig={FREEFORM_GRID_CONFIG}
          compactor={noCompactor}
          dragConfig={{ enabled: !readOnly, handle: ".finite-freeform-drag-handle" }}
          resizeConfig={{ enabled: false, handles: [] }}
          onDragStop={(_layout, _oldItem, newItem) => persistFreeformPosition(newItem)}
        >
          {freeformElements.map((element) => (
            <div key={element.id} className="finite-freeform-item" data-native-element-id={element.id}>
              <button
                type="button"
                className="finite-freeform-drag-handle"
                aria-label={t("conductor.presentation.moveElement", {
                  name: element.metadata.label || element.elementKind,
                })}
                title={t("conductor.presentation.moveElementHandle")}
                onClick={() => setSelectedElementId(element.id)}
              >
                <DotsSixVertical size={15} weight="bold" />
              </button>
              <ElementRenderer
                element={element}
                readOnly={readOnly}
                selected={selectedSet.has(element.id)}
                onDelete={onDeleteElement}
              />
            </div>
          ))}
        </GridLayout>

        {widgetElements.length === 0 && freeformElements.length === 0 && (
          <div className="finite-canvas-empty">{t("conductor.presentation.empty")}</div>
        )}
      </div>

      {canvasOnlyCount > 0 && (
        <div className="finite-canvas-only-note">
          {t("conductor.presentation.canvasOnly", { count: canvasOnlyCount })}
        </div>
      )}
    </div>
  );
};
