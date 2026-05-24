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

function snapToGrid(value: number, grid = SNAP_GRID): number {
  return Math.round(value / grid) * grid;
}

const NATIVE_DEFAULTS: Record<string, { w: number; h: number; zIndex: number }> = {
  text:    { w: 4, h: 2, zIndex: 0 },
  sticky:  { w: 3, h: 3, zIndex: 0 },
  shape:   { w: 4, h: 3, zIndex: 0 },
  frame:   { w: 8, h: 6, zIndex: 0 },
  section: { w: 6, h: 4, zIndex: -1 },
};

function isWidgetKind(el: CanvasElement) { return el.elementKind.startsWith("widget/"); }
function isConnectorKind(el: CanvasElement) {
  return el.elementKind === "shape/connector" || el.elementKind === "native/connector";
}

function hasNativeChrome(el: CanvasElement): boolean {
  return (
    el.elementKind === "native/shape" ||
    el.elementKind === "native/text" ||
    el.elementKind === "native/sticky" ||
    el.elementKind === "native/section"
  );
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
  const {
    canvasZoom, setCanvasZoom,
    setSelectedElementId,
    selectedElementIds, setSelectedElementIds,
    editingElementId,
    clearSelection,
    setCanvasScroll, setCanvasViewportSize,
    activeCanvasId, setUiError,
    activeTool, setActiveTool,
    undo, redo,
  } = useConductorStore();

  // ── Interaction state ──────────────────────────────────────────────────
  const [isPanning, setIsPanning]       = useState(false);
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [boxRect, setBoxRect]           = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Connector draw state (needs React state for SVG overlay rendering)
  const [connectorDraft, setConnectorDraft] = useState<{
    sourceId: string; sourcePx: { x: number; y: number };
    mouseX: number;  mouseY: number;
  } | null>(null);
  const connectorDraftRef = useRef(connectorDraft);
  connectorDraftRef.current = connectorDraft;

  // Drag state — kept in ref to avoid re-renders during mousemove
  const dragRef = useRef<{
    elementId: string;
    startMouseX: number;
    startMouseY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const panStartRef  = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const boxStartRef  = useRef<{ x: number; y: number } | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const hasCenteredRef = useRef(false);

  const freeformElements  = elements.filter(el => !isWidgetKind(el) && !isConnectorKind(el));
  const widgetElements    = elements.filter(el => isWidgetKind(el));
  const hasFreeformElements = freeformElements.length > 0;

  // ── Helpers ────────────────────────────────────────────────────────────

  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const host = scrollHostRef.current;
    if (!host) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    return {
      x: (clientX - rect.left + host.scrollLeft) / canvasZoom,
      y: (clientY - rect.top  + host.scrollTop)  / canvasZoom,
    };
  }, [canvasZoom]);

  const elementCenterPx = useCallback((el: CanvasElement) => ({
    x: el.position.x + (el.position.w * GRID_PX) / 2,
    y: el.position.y + (el.position.h * GRID_PX) / 2,
  }), []);

  const setHostCursor = useCallback((cursor: string) => {
    if (scrollHostRef.current) {
      scrollHostRef.current.style.cursor = cursor;
    }
  }, []);

  // ── Global mousemove / mouseup — single attach/detach ─────────────────
  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
      // Native element drag
      const d = dragRef.current;
      if (d) {
        if (!d.moved) {
          const screenDist = Math.hypot(e.clientX - d.startMouseX, e.clientY - d.startMouseY);
          if (screenDist < DRAG_THRESHOLD) return;
          d.moved = true;
        }

        const startCanvas = clientToCanvas(d.startMouseX, d.startMouseY);
        const currentCanvas = clientToCanvas(e.clientX, e.clientY);
        const ddx = currentCanvas.x - startCanvas.x;
        const ddy = currentCanvas.y - startCanvas.y;

        const { elements: els } = useConductorStore.getState();
        const el = els.find(el => el.id === d.elementId);
        if (!el) return;

        const newX = snapToGrid(d.origX + ddx);
        const newY = snapToGrid(d.origY + ddy);
        useConductorStore.getState().updateElement(d.elementId, {
          position: { ...el.position, x: newX, y: newY },
        });
      }

      // Connector draft line
      const cd = connectorDraftRef.current;
      if (cd) {
        const canvas = clientToCanvas(e.clientX, e.clientY);
        setConnectorDraft(prev => prev ? { ...prev, mouseX: canvas.x, mouseY: canvas.y } : null);
      }
    };

    const handleGlobalUp = async (e: MouseEvent) => {
      // Finish element drag
      const d = dragRef.current;
      if (d) {
        if (d.moved) {
          const { elements: els } = useConductorStore.getState();
          const el = els.find(el => el.id === d.elementId);
          if (el && onPositionChange) {
            onPositionChange(el.id, el.position);
          }
        }
        dragRef.current = null;
        setHostCursor("default");
      }

      // Finish connector draw
      const cd = connectorDraftRef.current;
      if (cd && activeCanvasId) {
        const canvasPoint = clientToCanvas(e.clientX, e.clientY);
        const { elements: els } = useConductorStore.getState();
        const target = els.find(el => {
          if (el.id === cd.sourceId) return false;
          const left = el.position.x;
          const top  = el.position.y;
          const right  = left + el.position.w * GRID_PX;
          const bottom = top  + el.position.h * GRID_PX;
          return canvasPoint.x >= left && canvasPoint.x <= right
              && canvasPoint.y >= top  && canvasPoint.y <= bottom;
        });

        if (target) {
          try {
            await createNativeElement(activeCanvasId, "connector", {
              x: 0, y: 0, w: 0, h: 0, zIndex: 10, rotation: 0,
            }, {
              source: { nodeId: cd.sourceId, anchorId: "center" },
              target: { nodeId: target.id,        anchorId: "center" },
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
    };

    window.addEventListener("mousemove", handleGlobalMove);
    window.addEventListener("mouseup",   handleGlobalUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMove);
      window.removeEventListener("mouseup",   handleGlobalUp);
    };
  }, [clientToCanvas, activeCanvasId, onPositionChange, setUiError, setActiveTool, setHostCursor]);

  // ── Canvas-level mousedown ─────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = e.target as HTMLElement;

    // ── Ignore react-grid items (widget layer) ──
    if (target.closest(".react-grid-item")) return;

    // ── Connector mode: start drawing from hovered native element ──
    if (activeTool === "connector") {
      const nativeEl = elements.find(el => {
        const domEl = document.getElementById(`native-el-${el.id}`);
        return domEl?.contains(target);
      });
      if (nativeEl) {
        e.preventDefault();
        e.stopPropagation();
        const canvas = clientToCanvas(e.clientX, e.clientY);
        setConnectorDraft({
          sourceId:  nativeEl.id,
          sourcePx:  elementCenterPx(nativeEl),
          mouseX:    canvas.x,
          mouseY:    canvas.y,
        });
        return;
      }
    }

    // ── Native element drag (start) ──
    const nativeWrapper = target.closest("[data-native-element-id]") as HTMLElement | null;
    if (nativeWrapper && !target.closest("[data-resize-handle]")) {
      const elementId = nativeWrapper.dataset.nativeElementId!;
      const el = elements.find(el => el.id === elementId);
      if (!el) return;

      const { editingElementId: editingId } = useConductorStore.getState();
      if (editingId === elementId) return;

      e.preventDefault();
      dragRef.current = {
        elementId,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        origX: el.position.x,
        origY: el.position.y,
        moved: false,
      };

      // Elements without NativeChrome get selection here
      // Elements with NativeChrome get selection from NativeChrome.onClick
      if (!hasNativeChrome(el)) {
        setSelectedElementId(elementId);
      }

      setHostCursor("grabbing");
      return;
    }

    const host = scrollHostRef.current;
    if (!host) return;

    // ── Ctrl/Meta drag = pan ──
    if (e.ctrlKey || e.metaKey) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, left: host.scrollLeft, top: host.scrollTop };
      return;
    }

    // ── Click on bare canvas = box-select or deselect ──
    const isOnBareCanvas =
      target === e.currentTarget ||
      target.classList.contains("canvas-inner") ||
      target.classList.contains("canvas-bg");

    if (isOnBareCanvas) {
      clearSelection();
      setIsBoxSelecting(true);
      const rect = host.getBoundingClientRect();
      boxStartRef.current = {
        x: e.clientX - rect.left + host.scrollLeft,
        y: e.clientY - rect.top  + host.scrollTop,
      };
      setBoxRect({ x: boxStartRef.current.x, y: boxStartRef.current.y, w: 0, h: 0 });
      return;
    }

    // ── Fallback: middle-mouse pan ──
    if (e.button === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, left: host.scrollLeft, top: host.scrollTop };
    }
  }, [readOnly, activeTool, elements, clientToCanvas, elementCenterPx,
      clearSelection, setSelectedElementId, setHostCursor]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isBoxSelecting && boxStartRef.current) {
      const host = scrollHostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left + host.scrollLeft;
      const cy = e.clientY - rect.top  + host.scrollTop;
      const sx = boxStartRef.current.x, sy = boxStartRef.current.y;
      setBoxRect({ x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) });
      return;
    }
    if (isPanning && panStartRef.current) {
      const host = scrollHostRef.current;
      if (!host) return;
      host.scrollLeft = panStartRef.current.left - (e.clientX - panStartRef.current.x);
      host.scrollTop  = panStartRef.current.top  - (e.clientY - panStartRef.current.y);
    }
  }, [isBoxSelecting, isPanning]);

  const handleMouseUp = useCallback(() => {
    if (isBoxSelecting && boxRect && boxRect.w > 4 && boxRect.h > 4) {
      const selected = freeformElements.filter(el => {
        const l = el.position.x, t = el.position.y;
        const r = l + el.position.w * GRID_PX, b = t + el.position.h * GRID_PX;
        return l < boxRect.x + boxRect.w && r > boxRect.x
            && t < boxRect.y + boxRect.h && b > boxRect.y;
      });
      setSelectedElementIds(selected.map(el => el.id));
    }
    setIsBoxSelecting(false);
    setBoxRect(null);
    boxStartRef.current = null;
    setIsPanning(false);
    panStartRef.current = null;
  }, [isBoxSelecting, boxRect, freeformElements, setSelectedElementIds]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setCanvasZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(canvasZoom + delta).toFixed(2))));
  }, [canvasZoom, setCanvasZoom]);

  // ── Keyboard ───────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const { editingElementId: editingId } = useConductorStore.getState();
    if (editingId) return;

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
        ids.forEach(id => onDeleteElement(id));
        clearSelection();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "a") { e.preventDefault(); setSelectedElementIds(freeformElements.map(el => el.id)); }
      if (e.key === "z") { e.preventDefault(); undo(); }
      if (e.key === "y") { e.preventDefault(); redo(); }
    }
  }, [clearSelection, setActiveTool, freeformElements, setSelectedElementIds, onDeleteElement, undo, redo]);

  // ── Drag-and-drop from toolbar ─────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-conductor-tool")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const toolType = e.dataTransfer.getData("application/x-conductor-tool");
    if (!toolType || !activeCanvasId) return;
    e.preventDefault();
    const extra = (() => {
      try { return JSON.parse(e.dataTransfer.getData("application/x-conductor-extra") || "{}"); }
      catch { return {}; }
    })();
    const canvas = clientToCanvas(e.clientX, e.clientY);
    const def = NATIVE_DEFAULTS[toolType] || { w: 4, h: 3, zIndex: 0 };
    const pxW = def.w * GRID_PX, pxH = def.h * GRID_PX;
    const position: CanvasPosition = {
      x: snapToGrid(canvas.x - pxW / 2),
      y: snapToGrid(canvas.y - pxH / 2),
      w: def.w, h: def.h, zIndex: def.zIndex, rotation: 0,
    };
    try {
      await createNativeElement(activeCanvasId, toolType, position, extra);
      setUiError(null);
    } catch (err) {
      setUiError(`Create ${toolType} failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [activeCanvasId, clientToCanvas, setUiError]);

  // ── Center canvas on mount ─────────────────────────────────────────────
  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host || hasCenteredRef.current) return;
    const cw = host.clientWidth, ch = host.clientHeight;
    const iw = Math.max(MIN_CANVAS_WIDTH, cw), ih = Math.max(MIN_CANVAS_HEIGHT, ch);
    host.scrollLeft = Math.max(0, (iw - cw) / 2);
    host.scrollTop  = Math.max(0, (ih - ch) / 2);
    hasCenteredRef.current = true;
  }, []);

  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host) return;
    const onScroll = () => setCanvasScroll(host.scrollLeft, host.scrollTop);
    const ro = new ResizeObserver(([e]) => {
      const cr = e.contentRect;
      setCanvasViewportSize(cr.width, cr.height);
    });
    ro.observe(host);
    host.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { ro.disconnect(); host.removeEventListener("scroll", onScroll); };
  }, [setCanvasScroll, setCanvasViewportSize]);

  // ── Cursor ─────────────────────────────────────────────────────────────
  const cursor = (() => {
    if (activeTool === "connector") return "crosshair";
    if (isPanning) return "grabbing";
    if (isBoxSelecting) return "crosshair";
    if (dragRef.current) return "grabbing";
    return "default";
  })();

  return (
    <div
      className="h-full overflow-auto canvas-area"
      ref={scrollHostRef}
      tabIndex={0}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor, outline: "none" }}
    >
      <div
        className="relative canvas-inner canvas-bg"
        style={{
          width: "100%",
          minWidth: MIN_CANVAS_WIDTH,
          height: "100%",
          minHeight: MIN_CANVAS_HEIGHT,
          zoom: canvasZoom,
          backgroundColor: "var(--bg-canvas)",
          backgroundImage: "radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
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

        {/* Box-select rect */}
        {boxRect && boxRect.w > 2 && boxRect.h > 2 && (
          <div
            style={{
              position: "absolute",
              left: boxRect.x, top: boxRect.y,
              width: boxRect.w, height: boxRect.h,
              border: "1px solid var(--accent)",
              backgroundColor: "rgba(99,102,241,0.07)",
              pointerEvents: "none",
              zIndex: 10000,
            }}
          />
        )}

        {/* Connector draft line */}
        {connectorDraft && (
          <svg
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none", zIndex: 9999 }}
          >
            <line
              x1={connectorDraft.sourcePx.x} y1={connectorDraft.sourcePx.y}
              x2={connectorDraft.mouseX}     y2={connectorDraft.mouseY}
              stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 3"
              strokeLinecap="round"
            />
            <circle cx={connectorDraft.sourcePx.x} cy={connectorDraft.sourcePx.y}
              r={5} fill="var(--main-bg)" stroke="var(--accent)" strokeWidth={2} />
          </svg>
        )}
      </div>
    </div>
  );
};