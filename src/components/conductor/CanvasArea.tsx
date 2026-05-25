"use client";

import React, { useCallback, useRef, useState, useEffect } from "react";
import type { CanvasElement, CanvasPosition } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { createNativeElement } from "@/lib/conductor-ipc";
import { FreeformLayer } from "./FreeformLayer";
import { WidgetLayer } from "./WidgetLayer";
import { ConnectorOverlay } from "./ConnectorOverlay";
import { NativeConnectorOverlay } from "./NativeConnectorOverlay";

const MIN_CANVAS_WIDTH = 3200;
const MIN_CANVAS_HEIGHT = 2400;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const GRID_PX = 80;
const SNAP_GRID = 20;
const DRAG_THRESHOLD = 3;
const ALIGN_THRESHOLD = 8;

type RenderGuide = { type: "vertical" | "horizontal"; value: number };

function snapToGrid(value: number, grid = SNAP_GRID): number {
  return Math.round(value / grid) * grid;
}

const NATIVE_DEFAULTS: Record<string, { w: number; h: number; zIndex: number }> = {
  text: { w: 4, h: 2, zIndex: 0 },
  sticky: { w: 3, h: 3, zIndex: 0 },
  shape: { w: 4, h: 3, zIndex: 0 },
  mindmap: { w: 8, h: 6, zIndex: 0 },
  frame: { w: 8, h: 6, zIndex: 0 },
  section: { w: 6, h: 4, zIndex: -1 },
};

export const canvasTransformState = { panX: 0, panY: 0, zoom: 1 };

function parseCreateTool(activeTool: string | null): { type: string; extra: Record<string, unknown> } | null {
  if (!activeTool?.startsWith("create:")) return null;
  const [, type, encodedExtra] = activeTool.split(":");
  if (!type) return null;
  if (!encodedExtra) return { type, extra: {} };

  try {
    return { type, extra: JSON.parse(decodeURIComponent(encodedExtra)) as Record<string, unknown> };
  } catch {
    return { type, extra: {} };
  }
}

function isWidgetKind(el: CanvasElement) {
  return el.elementKind.startsWith("widget/");
}

function isConnectorKind(el: CanvasElement) {
  return el.elementKind === "shape/connector" || el.elementKind === "native/connector";
}

function getElementBounds(element: CanvasElement, x = element.position.x, y = element.position.y) {
  const w = element.position.w * GRID_PX;
  const h = element.position.h * GRID_PX;
  return {
    left: x,
    right: x + w,
    centerX: x + w / 2,
    top: y,
    bottom: y + h,
    centerY: y + h / 2,
  };
}

function computeAlignmentSnap(
  moving: CanvasElement,
  allElements: CanvasElement[],
  skippedIds: Set<string>,
): { dx: number; dy: number; guides: RenderGuide[] } {
  const movingBounds = getElementBounds(moving);
  let bestDx: { delta: number; value: number } | null = null;
  let bestDy: { delta: number; value: number } | null = null;

  const movingVertical = [movingBounds.left, movingBounds.centerX, movingBounds.right];
  const movingHorizontal = [movingBounds.top, movingBounds.centerY, movingBounds.bottom];

  for (const other of allElements) {
    if (skippedIds.has(other.id) || isConnectorKind(other)) continue;
    const otherBounds = getElementBounds(other);
    const otherVertical = [otherBounds.left, otherBounds.centerX, otherBounds.right];
    const otherHorizontal = [otherBounds.top, otherBounds.centerY, otherBounds.bottom];

    for (const movingValue of movingVertical) {
      for (const otherValue of otherVertical) {
        const delta = otherValue - movingValue;
        if (Math.abs(delta) <= ALIGN_THRESHOLD && (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta))) {
          bestDx = { delta, value: otherValue };
        }
      }
    }

    for (const movingValue of movingHorizontal) {
      for (const otherValue of otherHorizontal) {
        const delta = otherValue - movingValue;
        if (Math.abs(delta) <= ALIGN_THRESHOLD && (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta))) {
          bestDy = { delta, value: otherValue };
        }
      }
    }
  }

  const guides: RenderGuide[] = [];
  if (bestDx) guides.push({ type: "vertical", value: bestDx.value });
  if (bestDy) guides.push({ type: "horizontal", value: bestDy.value });

  return {
    dx: bestDx?.delta ?? 0,
    dy: bestDy?.delta ?? 0,
    guides,
  };
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
  const setCanvasZoom = useConductorStore((state) => state.setCanvasZoom);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const setSelectedElementIds = useConductorStore((state) => state.setSelectedElementIds);
  const toggleElementSelection = useConductorStore((state) => state.toggleElementSelection);
  const clearSelection = useConductorStore((state) => state.clearSelection);
  const setCanvasScroll = useConductorStore((state) => state.setCanvasScroll);
  const setCanvasViewportSize = useConductorStore((state) => state.setCanvasViewportSize);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setUiError = useConductorStore((state) => state.setUiError);
  const activeTool = useConductorStore((state) => state.activeTool);
  const setActiveTool = useConductorStore((state) => state.setActiveTool);
  const undo = useConductorStore((state) => state.undo);
  const redo = useConductorStore((state) => state.redo);

  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [boxRect, setBoxRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<RenderGuide[]>([]);

  const [connectorDraft, setConnectorDraft] = useState<{
    sourceId: string;
    sourcePx: { x: number; y: number };
    mouseX: number;
    mouseY: number;
  } | null>(null);
  const connectorDraftRef = useRef(connectorDraft);
  connectorDraftRef.current = connectorDraft;

  const dragRef = useRef<{
    elementId: string;
    startMouseX: number;
    startMouseY: number;
    targets: Array<{ id: string; origX: number; origY: number }>;
    moved: boolean;
    rafId: number | null;
    lastClientX: number;
    lastClientY: number;
  } | null>(null);

  const boxStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasCenteredRef = useRef(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasElRef = useRef<HTMLDivElement | null>(null);

  const transformRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  const cursorRef = useRef("default");

  const panRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyTransform = useCallback(() => {
    const { panX, panY, zoom } = transformRef.current;
    const el = canvasElRef.current;
    if (el) {
      el.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
    canvasTransformState.panX = panX;
    canvasTransformState.panY = panY;
    canvasTransformState.zoom = zoom;
  }, []);

  const syncCanvasStateToStore = useCallback(() => {
    if (syncTimerRef.current !== null) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      const { panX, panY, zoom } = transformRef.current;
      const store = useConductorStore.getState();
      if (store.canvasZoom !== zoom) {
        setCanvasZoom(zoom);
      }
      setCanvasScroll(panX, panY);
      syncTimerRef.current = null;
    }, 50);
  }, [setCanvasZoom, setCanvasScroll]);

  const freeformElements = elements.filter((el) => !isWidgetKind(el) && !isConnectorKind(el));
  const widgetElements = elements.filter((el) => isWidgetKind(el));
  const hasFreeformElements = freeformElements.length > 0;

  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const host = viewportRef.current;
    if (!host) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    const { panX, panY, zoom } = transformRef.current;
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }, []);

  const elementCenterPx = useCallback((el: CanvasElement) => ({
    x: el.position.x + (el.position.w * GRID_PX) / 2,
    y: el.position.y + (el.position.h * GRID_PX) / 2,
  }), []);

  const setHostCursor = useCallback((cursor: string) => {
    cursorRef.current = cursor;
    if (viewportRef.current) {
      viewportRef.current.style.cursor = cursor;
    }
  }, []);

  const createElementAt = useCallback(async (
    type: string,
    extra: Record<string, unknown>,
    canvasX: number,
    canvasY: number,
  ) => {
    if (!activeCanvasId) return;
    const def = NATIVE_DEFAULTS[type] || { w: 4, h: 3, zIndex: 0 };
    const pxW = def.w * GRID_PX;
    const pxH = def.h * GRID_PX;
    const position: CanvasPosition = {
      x: snapToGrid(canvasX - pxW / 2),
      y: snapToGrid(canvasY - pxH / 2),
      w: def.w,
      h: def.h,
      zIndex: def.zIndex,
      rotation: 0,
    };

    try {
      await createNativeElement(activeCanvasId, type, position, extra);
      setUiError(null);
      setActiveTool(null);
    } catch (err) {
      setUiError(`Create ${type} failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [activeCanvasId, setActiveTool, setUiError]);

  useEffect(() => {
    const flushDragFrame = () => {
      const d = dragRef.current;
      if (!d) return;
      d.rafId = null;

      const startCanvas = clientToCanvas(d.startMouseX, d.startMouseY);
      const currentCanvas = clientToCanvas(d.lastClientX, d.lastClientY);
      const dx = currentCanvas.x - startCanvas.x;
      const dy = currentCanvas.y - startCanvas.y;
      const targets = new Map(d.targets.map((target) => [target.id, target]));
      const skippedIds = new Set(d.targets.map((target) => target.id));
      let guideOffset = { dx: 0, dy: 0, guides: [] as RenderGuide[] };

      const { elements: latestElements } = useConductorStore.getState();
      const primary = latestElements.find((el) => el.id === d.elementId);
      const primaryStart = targets.get(d.elementId);
      if (primary && primaryStart) {
        const proposedPrimary: CanvasElement = {
          ...primary,
          position: {
            ...primary.position,
            x: snapToGrid(primaryStart.origX + dx),
            y: snapToGrid(primaryStart.origY + dy),
          },
        };
        guideOffset = computeAlignmentSnap(proposedPrimary, latestElements, skippedIds);
      }

      setAlignmentGuides(guideOffset.guides);

      useConductorStore.setState((state) => ({
        elements: state.elements.map((el) => {
          const target = targets.get(el.id);
          if (!target) return el;
          return {
            ...el,
            position: {
              ...el.position,
              x: snapToGrid(target.origX + dx) + guideOffset.dx,
              y: snapToGrid(target.origY + dy) + guideOffset.dy,
            },
          };
        }),
      }));
    };

    const handleGlobalMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) {
        if (!d.moved) {
          const screenDist = Math.hypot(e.clientX - d.startMouseX, e.clientY - d.startMouseY);
          if (screenDist < DRAG_THRESHOLD) return;
          d.moved = true;
        }

        d.lastClientX = e.clientX;
        d.lastClientY = e.clientY;
        if (d.rafId === null) {
          d.rafId = window.requestAnimationFrame(flushDragFrame);
        }
      }

      const cd = connectorDraftRef.current;
      if (cd) {
        const canvas = clientToCanvas(e.clientX, e.clientY);
        setConnectorDraft((prev) => prev ? { ...prev, mouseX: canvas.x, mouseY: canvas.y } : null);
      }
    };

    const handleGlobalUp = async (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) {
        if (d.rafId !== null) {
          window.cancelAnimationFrame(d.rafId);
          flushDragFrame();
        }

        if (d.moved && onPositionChange) {
          const { elements: els } = useConductorStore.getState();
          d.targets.forEach((target) => {
            const el = els.find((candidate) => candidate.id === target.id);
            if (el) onPositionChange(el.id, el.position);
          });
        }

        dragRef.current = null;
        setAlignmentGuides([]);
        setHostCursor("default");
      }

      const cd = connectorDraftRef.current;
      if (cd && activeCanvasId) {
        const canvasPoint = clientToCanvas(e.clientX, e.clientY);
        const { elements: els } = useConductorStore.getState();
        const target = els.find((el) => {
          if (el.id === cd.sourceId) return false;
          const left = el.position.x;
          const top = el.position.y;
          const right = left + el.position.w * GRID_PX;
          const bottom = top + el.position.h * GRID_PX;
          return canvasPoint.x >= left && canvasPoint.x <= right
            && canvasPoint.y >= top && canvasPoint.y <= bottom;
        });

        if (target) {
          try {
            await createNativeElement(activeCanvasId, "connector", {
              x: 0,
              y: 0,
              w: 0,
              h: 0,
              zIndex: 10,
              rotation: 0,
            }, {
              source: { nodeId: cd.sourceId, anchorId: "center" },
              target: { nodeId: target.id, anchorId: "center" },
              curvature: 0.4,
              routingMode: "bezier",
            });
          } catch (err) {
            setUiError(`Create connector failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        setConnectorDraft(null);
        setActiveTool(null);
      }

      if (panRef.current?.active) {
        panRef.current = null;
        syncCanvasStateToStore();
      }
    };

    window.addEventListener("mousemove", handleGlobalMove);
    window.addEventListener("mouseup", handleGlobalUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMove);
      window.removeEventListener("mouseup", handleGlobalUp);
    };
  }, [clientToCanvas, activeCanvasId, onPositionChange, setUiError, setActiveTool, setHostCursor, syncCanvasStateToStore]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = e.target as HTMLElement;

    if (target.tagName === "IFRAME") return;

    if (target.closest(".react-grid-item")) return;

    if (activeTool === "connector") {
      const nativeEl = elements.find((el) => {
        const domEl = document.getElementById(`native-el-${el.id}`);
        return domEl?.contains(target);
      });
      if (nativeEl) {
        e.preventDefault();
        e.stopPropagation();
        const canvas = clientToCanvas(e.clientX, e.clientY);
        setConnectorDraft({
          sourceId: nativeEl.id,
          sourcePx: elementCenterPx(nativeEl),
          mouseX: canvas.x,
          mouseY: canvas.y,
        });
        return;
      }
    }

    const nativeWrapper = target.closest("[data-native-element-id]") as HTMLElement | null;
    if (nativeWrapper && !target.closest("[data-resize-handle]")) {
      const elementId = nativeWrapper.dataset.nativeElementId;
      if (!elementId) return;
      const el = elements.find((candidate) => candidate.id === elementId);
      if (!el) return;

      const { editingElementId } = useConductorStore.getState();
      if (editingElementId === elementId) return;

      e.preventDefault();

      if (e.shiftKey) {
        toggleElementSelection(elementId);
        return;
      }

      const { selectedElementIds: currentSelection } = useConductorStore.getState();
      const shouldDragSelection = currentSelection.includes(elementId) && currentSelection.length > 1;
      const targetIds = shouldDragSelection ? currentSelection : [elementId];
      const dragTargets = targetIds
        .map((id) => {
          const targetElement = elements.find((candidate) => candidate.id === id);
          return targetElement
            ? { id, origX: targetElement.position.x, origY: targetElement.position.y }
            : null;
        })
        .filter((value): value is { id: string; origX: number; origY: number } => value !== null);

      dragRef.current = {
        elementId,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        targets: dragTargets.length > 0 ? dragTargets : [{ id: elementId, origX: el.position.x, origY: el.position.y }],
        moved: false,
        rafId: null,
        lastClientX: e.clientX,
        lastClientY: e.clientY,
      };

      if (!shouldDragSelection) {
        setSelectedElementId(elementId);
      }

      setHostCursor("grabbing");
      return;
    }

    if (e.ctrlKey || e.metaKey || e.button === 1) {
      e.preventDefault();
      panRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: transformRef.current.panX,
        startPanY: transformRef.current.panY,
      };
      setHostCursor("grabbing");
      return;
    }

    const isOnBareCanvas =
      target === e.currentTarget ||
      target.classList.contains("canvas-inner") ||
      target.classList.contains("canvas-bg") ||
      target.classList.contains("freeform-layer");

    if (isOnBareCanvas) {
      const createTool = parseCreateTool(activeTool);
      if (createTool) {
        e.preventDefault();
        const canvas = clientToCanvas(e.clientX, e.clientY);
        void createElementAt(createTool.type, createTool.extra, canvas.x, canvas.y);
        return;
      }

      clearSelection();
      setIsBoxSelecting(true);
      const rect = viewportRef.current!.getBoundingClientRect();
      const { panX, panY, zoom } = transformRef.current;
      boxStartRef.current = {
        x: (e.clientX - rect.left - panX) / zoom,
        y: (e.clientY - rect.top - panY) / zoom,
      };
      setBoxRect({ x: boxStartRef.current.x, y: boxStartRef.current.y, w: 0, h: 0 });
    }
  }, [
    readOnly,
    activeTool,
    elements,
    clientToCanvas,
    elementCenterPx,
    createElementAt,
    clearSelection,
    setSelectedElementId,
    setHostCursor,
    toggleElementSelection,
  ]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (panRef.current?.active) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      transformRef.current.panX = Math.round(panRef.current.startPanX + dx);
      transformRef.current.panY = Math.round(panRef.current.startPanY + dy);
      applyTransform();
      return;
    }

    if (isBoxSelecting && boxStartRef.current) {
      const host = viewportRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const { panX, panY, zoom } = transformRef.current;
      const cx = (e.clientX - rect.left - panX) / zoom;
      const cy = (e.clientY - rect.top - panY) / zoom;
      const sx = boxStartRef.current.x;
      const sy = boxStartRef.current.y;
      setBoxRect({ x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) });
      return;
    }
  }, [isBoxSelecting, applyTransform]);

  const handleMouseUp = useCallback(() => {
    if (isBoxSelecting && boxRect && boxRect.w > 4 && boxRect.h > 4) {
      const selected = freeformElements.filter((el) => {
        const left = el.position.x;
        const top = el.position.y;
        const right = left + el.position.w * GRID_PX;
        const bottom = top + el.position.h * GRID_PX;
        return left < boxRect.x + boxRect.w && right > boxRect.x
          && top < boxRect.y + boxRect.h && bottom > boxRect.y;
      });
      setSelectedElementIds(selected.map((el) => el.id));
    }

    setIsBoxSelecting(false);
    setBoxRect(null);
    boxStartRef.current = null;

    if (panRef.current?.active) {
      panRef.current = null;
      syncCanvasStateToStore();
      setHostCursor("default");
    }
  }, [isBoxSelecting, boxRect, freeformElements, setSelectedElementIds, syncCanvasStateToStore, setHostCursor]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();

    const host = viewportRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const { zoom, panX, panY } = transformRef.current;

    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, +(zoom + (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)).toFixed(2)),
    );
    if (nextZoom === zoom) return;

    const anchorX = e.clientX - rect.left;
    const anchorY = e.clientY - rect.top;
    const canvasAnchorX = (anchorX - panX) / zoom;
    const canvasAnchorY = (anchorY - panY) / zoom;

    transformRef.current.zoom = nextZoom;
    transformRef.current.panX = Math.round(anchorX - canvasAnchorX * nextZoom);
    transformRef.current.panY = Math.round(anchorY - canvasAnchorY * nextZoom);

    applyTransform();
    syncCanvasStateToStore();
  }, [applyTransform, syncCanvasStateToStore]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const { editingElementId } = useConductorStore.getState();
    if (editingElementId) return;

    if (e.key === "Escape") {
      clearSelection();
      setActiveTool(null);
      setConnectorDraft(null);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      const { selectedElementIds: selIds, selectedElementId: selId } = useConductorStore.getState();
      const ids = selIds.length > 0 ? selIds : selId ? [selId] : [];
      if (ids.length > 0 && onDeleteElement) {
        e.preventDefault();
        ids.forEach((id) => onDeleteElement(id));
        clearSelection();
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "a") {
        e.preventDefault();
        setSelectedElementIds(freeformElements.map((el) => el.id));
      }
      if (e.key === "z") {
        e.preventDefault();
        void undo();
      }
      if (e.key === "y") {
        e.preventDefault();
        void redo();
      }
    }
  }, [clearSelection, setActiveTool, freeformElements, setSelectedElementIds, onDeleteElement, undo, redo]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-conductor-tool")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const toolType = e.dataTransfer.getData("application/x-conductor-tool");
    if (!toolType) return;
    e.preventDefault();
    const extra = (() => {
      try {
        return JSON.parse(e.dataTransfer.getData("application/x-conductor-extra") || "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const canvas = clientToCanvas(e.clientX, e.clientY);
    void createElementAt(toolType, extra, canvas.x, canvas.y);
  }, [clientToCanvas, createElementAt]);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host || hasCenteredRef.current) return;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    transformRef.current.panX = Math.round((cw - MIN_CANVAS_WIDTH) / 2);
    transformRef.current.panY = Math.round((ch - MIN_CANVAS_HEIGHT) / 2);
    applyTransform();
    syncCanvasStateToStore();
    hasCenteredRef.current = true;
  }, [applyTransform, syncCanvasStateToStore]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const { editingElementId } = useConductorStore.getState();
      if (editingElementId) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        const { selectedElementIds: selIds, selectedElementId: selId } = useConductorStore.getState();
        const ids = selIds.length > 0 ? selIds : selId ? [selId] : [];
        if (ids.length > 0 && onDeleteElement) {
          e.preventDefault();
          ids.forEach((id) => onDeleteElement(id));
          clearSelection();
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [onDeleteElement, clearSelection]);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect;
      setCanvasViewportSize(cr.width, cr.height);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
    };
  }, [setCanvasViewportSize]);

  const cursor = (() => {
    if (activeTool === "connector") return "crosshair";
    if (parseCreateTool(activeTool)) return "copy";
    if (panRef.current?.active) return "grabbing";
    if (isBoxSelecting) return "crosshair";
    if (dragRef.current) return "grabbing";
    return "default";
  })();

  return (
    <div
      className="h-full overflow-hidden canvas-area"
      ref={viewportRef}
      tabIndex={0}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{
        cursor,
        outline: "none",
        overscrollBehavior: "none",
        touchAction: "none",
      }}
    >
      <div
        className="relative canvas-inner canvas-bg"
        ref={canvasElRef}
        style={{
          width: MIN_CANVAS_WIDTH,
          height: MIN_CANVAS_HEIGHT,
          transformOrigin: "0 0",
          transform: "translate(0px, 0px) scale(1)",
          willChange: "transform",
          contain: "layout style paint",
          backfaceVisibility: "hidden",
          WebkitBackfaceVisibility: "hidden",
          backgroundColor: "var(--bg-canvas)",
          backgroundImage: "radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          shapeRendering: "geometricPrecision",
          textRendering: "geometricPrecision",
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
              <WidgetLayer elements={widgetElements} readOnly={readOnly} />
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
            <NativeConnectorOverlay elements={elements} />
          </>
        ) : (
          <WidgetLayer elements={widgetElements} readOnly={readOnly} />
        )}

        {boxRect && boxRect.w > 2 && boxRect.h > 2 && (
          <div
            style={{
              position: "absolute",
              left: boxRect.x,
              top: boxRect.y,
              width: boxRect.w,
              height: boxRect.h,
              border: "1px solid var(--accent)",
              backgroundColor: "rgba(99,102,241,0.07)",
              pointerEvents: "none",
              zIndex: 10000,
            }}
          />
        )}

        {alignmentGuides.map((guide, index) => (
          <div
            key={`${guide.type}-${guide.value}-${index}`}
            style={{
              position: "absolute",
              pointerEvents: "none",
              zIndex: 10001,
              background: "#FF4FB8",
              boxShadow: "0 0 0 1px rgba(255, 79, 184, 0.18)",
              ...(guide.type === "vertical"
                ? { left: guide.value, top: 0, width: 1, height: "100%" }
                : { left: 0, top: guide.value, width: "100%", height: 1 }),
            }}
          />
        ))}

        {connectorDraft && (
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              overflow: "visible",
              pointerEvents: "none",
              zIndex: 9999,
            }}
          >
            <line
              x1={connectorDraft.sourcePx.x}
              y1={connectorDraft.sourcePx.y}
              x2={connectorDraft.mouseX}
              y2={connectorDraft.mouseY}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="6 3"
              strokeLinecap="round"
            />
            <circle
              cx={connectorDraft.sourcePx.x}
              cy={connectorDraft.sourcePx.y}
              r={5}
              fill="var(--main-bg)"
              stroke="var(--accent)"
              strokeWidth={2}
            />
          </svg>
        )}
      </div>
    </div>
  );
};