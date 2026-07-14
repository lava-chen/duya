"use client";

import React, { useCallback, useRef, useState, useEffect } from "react";
import type { CanvasElement, CanvasPosition } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { createNativeElement, executeAction, uploadAsset } from "..//ipc/conductor-ipc";
import { FreeformLayer } from "./FreeformLayer";
import { ConnectorOverlay } from "./ConnectorOverlay";
import { NativeConnectorOverlay } from "./NativeConnectorOverlay";
import { GroupLayer } from "./GroupLayer";
import { StylePanel } from "./StylePanel";
import { MultiSelectBar } from "./MultiSelectBar";
import { GRID_PX } from "../domain/canvas/units";
import { computeSnap } from "../domain/canvas/snap";
import { zoomToFit } from "../domain/canvas/layout/viewport";
import { canvasSpatialIndex } from "../stores/conductor-store";
import type { AlignmentGuide } from "../domain/canvas/snap";

const MIN_CANVAS_WIDTH = 3200;
const MIN_CANVAS_HEIGHT = 2400;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const MIN_READABLE_FIT_ZOOM = 0.65;
const ZOOM_STEP = 0.1;
const SNAP_GRID = 20;
const DRAG_THRESHOLD = 3;
const ALIGN_THRESHOLD = 8;

// Apple-style interaction constants
const ZOOM_ELASTIC_MIN = 0.15;
const ZOOM_ELASTIC_MAX = 3.5;
const PAN_INERTIA_DECAY = 0.95;
const PAN_INERTIA_THRESHOLD = 0.5;
const PAN_INERTIA_MAX_MS = 1500;
const KEYBOARD_PAN_STEP = 40;
const KEYBOARD_ZOOM_STEP = 0.15;

type RenderGuide = AlignmentGuide;

function snapToGrid(value: number, grid = SNAP_GRID): number {
  return Math.round(value / grid) * grid;
}

const NATIVE_DEFAULTS: Record<string, { w: number; h: number; zIndex: number }> = {
  sticky: { w: 3, h: 2, zIndex: 0 },
  image: { w: 5, h: 4, zIndex: 0 },
  file: { w: 4, h: 3, zIndex: 0 },
  group: { w: 0, h: 0, zIndex: -1 },
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

function isConnectorKind(el: CanvasElement | undefined | null) {
  if (!el || typeof el.elementKind !== "string") return false;
  return el.elementKind === "native/connector";
}

function isGroupKind(el: CanvasElement | undefined | null) {
  if (!el || typeof el.elementKind !== "string") return false;
  return el.elementKind === "native/group";
}

function getElementBounds(element: CanvasElement, x = element.position.x, y = element.position.y) {
  // x/y are in grid units (canvas-persisted), so convert to pixels here so
  // the returned bbox is in a single unit space — alignment snap compares
  // boxes against each other and renders them onto the transformed viewport,
  // both of which need pixel coordinates.
  const pxX = x * GRID_PX;
  const pxY = y * GRID_PX;
  const w = element.position.w * GRID_PX;
  const h = element.position.h * GRID_PX;
  return {
    left: pxX,
    right: pxX + w,
    centerX: pxX + w / 2,
    top: pxY,
    bottom: pxY + h,
    centerY: pxY + h / 2,
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
  const [zoomDisplay, setZoomDisplay] = useState(1);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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
    lastX: number;
    lastY: number;
    lastTime: number;
    velocityX: number;
    velocityY: number;
  } | null>(null);

  const inertiaRef = useRef<{
    rafId: number | null;
    velocityX: number;
    velocityY: number;
    startTime: number;
  } | null>(null);

  const spaceHeldRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomFitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastViewportWRef = useRef(0);
  const lastViewportHRef = useRef(0);
  const userZoomLockRef = useRef(false);

  const applyTransform = useCallback(() => {
    const { panX, panY, zoom } = transformRef.current;
    const el = canvasElRef.current;
    if (el) {
      el.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
    canvasTransformState.panX = panX;
    canvasTransformState.panY = panY;
    canvasTransformState.zoom = zoom;
    setZoomDisplay(zoom);
  }, []);

  // Clamp zoom with elastic bounds — allows overshoot during gesture, snaps back on release
  const clampZoomElastic = useCallback((zoom: number): number => {
    return Math.min(ZOOM_ELASTIC_MAX, Math.max(ZOOM_ELASTIC_MIN, zoom));
  }, []);

  // Clamp zoom to hard bounds (used on release)
  const clampZoomHard = useCallback((zoom: number): number => {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }, []);

  // Debounced sync of transform state to the conductor store
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

  const runZoomToFit = useCallback(() => {
    if (userZoomLockRef.current) return;
    const { elements: els } = useConductorStore.getState();
    if (els.length === 0) return;
    const { canvasViewportW, canvasViewportH } = useConductorStore.getState();
    // Convert viewport px to grid units for the layout function.
    const viewportGrid = { width: canvasViewportW / GRID_PX, height: canvasViewportH / GRID_PX };
    const result = zoomToFit(els, {
      viewport: viewportGrid,
      // Keep auto-fit readable. Users can still zoom farther out manually,
      // but opening a dense board should not turn 18-22px labels into
      // illegible single-digit screen pixels just to show every edge.
      minZoom: MIN_READABLE_FIT_ZOOM,
      maxZoom: 1.5,
      padding: 1,
      respectMinSize: false,
    });
    transformRef.current.zoom = result.zoom;
    // Pan to center the fitted bbox. panX/panY are in px.
    transformRef.current.panX = result.panX * GRID_PX;
    transformRef.current.panY = result.panY * GRID_PX;
    applyTransform();
    syncCanvasStateToStore();
  }, [applyTransform, syncCanvasStateToStore]);

  // Start inertia panning after drag-pan release
  const startInertia = useCallback((velocityX: number, velocityY: number) => {
    // Cancel any existing inertia
    if (inertiaRef.current?.rafId !== null) {
      if (inertiaRef.current?.rafId) window.cancelAnimationFrame(inertiaRef.current.rafId);
    }

    const startTime = performance.now();
    inertiaRef.current = { rafId: null, velocityX, velocityY, startTime };

    const tick = () => {
      const inertia = inertiaRef.current;
      if (!inertia) return;

      const elapsed = performance.now() - inertia.startTime;
      if (elapsed > PAN_INERTIA_MAX_MS ||
          (Math.abs(inertia.velocityX) < PAN_INERTIA_THRESHOLD && Math.abs(inertia.velocityY) < PAN_INERTIA_THRESHOLD)) {
        inertiaRef.current = null;
        syncCanvasStateToStore();
        return;
      }

      transformRef.current.panX += inertia.velocityX;
      transformRef.current.panY += inertia.velocityY;
      applyTransform();

      inertia.velocityX *= PAN_INERTIA_DECAY;
      inertia.velocityY *= PAN_INERTIA_DECAY;

      inertia.rafId = window.requestAnimationFrame(tick);
    };

    inertiaRef.current.rafId = window.requestAnimationFrame(tick);
  }, [applyTransform, syncCanvasStateToStore]);

  const cancelInertia = useCallback(() => {
    if (inertiaRef.current?.rafId) {
      window.cancelAnimationFrame(inertiaRef.current.rafId);
    }
    inertiaRef.current = null;
  }, []);

  // Spring zoom back to hard bounds (called on release when in elastic zone)
  const springZoomToHard = useCallback(() => {
    const currentZoom = transformRef.current.zoom;
    const targetZoom = clampZoomHard(currentZoom);
    if (Math.abs(currentZoom - targetZoom) < 0.001) return;

    const startZoom = currentZoom;
    const startTime = performance.now();
    const duration = 300;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      // Spring easing
      const eased = 1 - Math.pow(1 - t, 3);
      transformRef.current.zoom = startZoom + (targetZoom - startZoom) * eased;
      applyTransform();

      if (t < 1) {
        window.requestAnimationFrame(animate);
      } else {
        transformRef.current.zoom = targetZoom;
        applyTransform();
        syncCanvasStateToStore();
      }
    };
    window.requestAnimationFrame(animate);
  }, [applyTransform, clampZoomHard, syncCanvasStateToStore]);

  const freeformElements = elements.filter((el) => !isConnectorKind(el) && !isGroupKind(el));
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
    // All inputs in grid units — convert x/y to pixels first so the math
    // mixes only pixel-scale values.
    x: el.position.x * GRID_PX + (el.position.w * GRID_PX) / 2,
    y: el.position.y * GRID_PX + (el.position.h * GRID_PX) / 2,
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
    // canvasX/canvasY are canvas-perspective pixels; CanvasPosition.x/y
    // are persisted in grid units (1 unit = GRID_PX), so divide back.
    const position: CanvasPosition = {
      x: snapToGrid(canvasX - pxW / 2) / GRID_PX,
      y: snapToGrid(canvasY - pxH / 2) / GRID_PX,
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

  const dropFileAt = useCallback(async (file: File, canvasX: number, canvasY: number) => {
    if (!activeCanvasId) return;
    try {
      const asset = await uploadAsset(activeCanvasId, file);
      const def = NATIVE_DEFAULTS[asset.kind] || { w: 4, h: 3, zIndex: 0 };
      const pxW = def.w * GRID_PX;
      const pxH = def.h * GRID_PX;
      // canvasX/canvasY are canvas-perspective pixels; CanvasPosition.x/y
      // are persisted in grid units (1 unit = GRID_PX), so divide back.
      const position: CanvasPosition = {
        x: snapToGrid(canvasX - pxW / 2) / GRID_PX,
        y: snapToGrid(canvasY - pxH / 2) / GRID_PX,
        w: def.w,
        h: def.h,
        zIndex: def.zIndex,
        rotation: 0,
      };
      const extra: Record<string, unknown> = {
        assetId: asset.assetId,
        url: asset.url,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
      };
      await createNativeElement(activeCanvasId, asset.kind, position, extra);
      setUiError(null);
    } catch (err) {
      setUiError(`Upload media failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [activeCanvasId, setUiError]);

  useEffect(() => {
    const flushDragFrame = () => {
      const d = dragRef.current;
      if (!d) return;
      d.rafId = null;

      const startCanvas = clientToCanvas(d.startMouseX, d.startMouseY);
      const currentCanvas = clientToCanvas(d.lastClientX, d.lastClientY);
      // dx/dy are canvas-perspective pixel deltas. `targets` carry their
      // origin in grid units (matches the canvas model), so convert the
      // delta back to grid before applying.
      const dxPx = currentCanvas.x - startCanvas.x;
      const dyPx = currentCanvas.y - startCanvas.y;
      const dxGrid = dxPx / GRID_PX;
      const dyGrid = dyPx / GRID_PX;
      const targets = new Map(d.targets.map((target) => [target.id, target]));

      const { elements: latestElements } = useConductorStore.getState();
      const primary = latestElements.find((el) => el.id === d.elementId);
      const primaryStart = targets.get(d.elementId);
      if (!primary || !primaryStart) return;

      // 1. Compute the proposed primary position (raw, no snap yet).
      const proposedPrimary: CanvasElement = {
        ...primary,
        position: {
          ...primary.position,
          x: primaryStart.origX + dxGrid,
          y: primaryStart.origY + dyGrid,
        },
      };

      // 2. Compute alignment snap on the proposed primary. Overlap is
      // intentional: dragging one item must never rearrange unrelated
      // content. Explicit auto-layout remains available from the toolbar.
      const snapResult = computeSnap(proposedPrimary, latestElements, { threshold: ALIGN_THRESHOLD });

      // 3. Determine final primary position.
      const finalX = snapResult.kind === 'alignment' ? snapResult.x : proposedPrimary.position.x;
      const finalY = snapResult.kind === 'alignment' ? snapResult.y : proposedPrimary.position.y;
      const snapDx = finalX - proposedPrimary.position.x;
      const snapDy = finalY - proposedPrimary.position.y;

      // 4. Render alignment guides.
      setAlignmentGuides(snapResult.kind === 'alignment' ? snapResult.guides : []);

      // 5. Apply positions only to the user's drag targets.
      useConductorStore.setState((state) => ({
        elements: state.elements.map((el) => {
          const target = targets.get(el.id);
          if (target) {
            // Dragged element (or multi-select target): apply raw delta + snap offset.
            return {
              ...el,
              position: {
                ...el.position,
                x: target.origX + dxGrid + snapDx,
                y: target.origY + dyGrid + snapDy,
              },
            };
          }
          return el;
        }),
      }));

      // 6. Sync the spatial index for the dragged elements only.
      const updatedEls = useConductorStore.getState().elements;
      for (const target of d.targets) {
        const el = updatedEls.find((e) => e.id === target.id);
        if (el) canvasSpatialIndex.upsert(el);
      }
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
          // No grid snap on commit — the element stays at its released position
          // (alignment-snap already applied during the drag in flushDragFrame).
          // This is the "free placement" behavior: snap to alignment lines only.
          const { elements: releasedEls } = useConductorStore.getState();
          d.targets.forEach((target) => {
            const el = releasedEls.find((candidate) => candidate.id === target.id);
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
          // canvasPoint is in canvas-perspective pixels; compare with a
          // pixel bbox so both axes agree.
          const left = el.position.x * GRID_PX;
          const top = el.position.y * GRID_PX;
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
        // Start inertia if velocity is significant
        const vx = panRef.current.velocityX;
        const vy = panRef.current.velocityY;
        panRef.current = null;
        setHostCursor(spaceHeldRef.current ? "grab" : "default");

        if (Math.abs(vx) > 2 || Math.abs(vy) > 2) {
          startInertia(vx, vy);
        } else {
          syncCanvasStateToStore();
        }
      }

      // Spring zoom back to hard bounds if in elastic zone
      const currentZoom = transformRef.current.zoom;
      if (currentZoom < MIN_ZOOM || currentZoom > MAX_ZOOM) {
        springZoomToHard();
      }

      if (isDragging) {
        setIsDragging(false);
      }
    };

    window.addEventListener("mousemove", handleGlobalMove);
    window.addEventListener("mouseup", handleGlobalUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMove);
      window.removeEventListener("mouseup", handleGlobalUp);
    };
  }, [clientToCanvas, activeCanvasId, onPositionChange, setUiError, setActiveTool, setHostCursor, syncCanvasStateToStore, startInertia, springZoomToHard, isDragging]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = e.target as HTMLElement;

    if (target.tagName === "IFRAME") return;

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
      if (target.closest("input, textarea, select, button, [contenteditable='true']")) {
        return;
      }
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

    if (e.ctrlKey || e.metaKey || e.button === 1 || spaceHeldRef.current) {
      e.preventDefault();
      cancelInertia();
      panRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: transformRef.current.panX,
        startPanY: transformRef.current.panY,
        lastX: e.clientX,
        lastY: e.clientY,
        lastTime: performance.now(),
        velocityX: 0,
        velocityY: 0,
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

      // Track velocity for inertia
      const now = performance.now();
      const dt = now - panRef.current.lastTime;
      if (dt > 0) {
        const vx = (e.clientX - panRef.current.lastX) / dt * 16; // px per frame (~16ms)
        const vy = (e.clientY - panRef.current.lastY) / dt * 16;
        // Smooth velocity (exponential moving average)
        panRef.current.velocityX = panRef.current.velocityX * 0.6 + vx * 0.4;
        panRef.current.velocityY = panRef.current.velocityY * 0.6 + vy * 0.4;
      }
      panRef.current.lastX = e.clientX;
      panRef.current.lastY = e.clientY;
      panRef.current.lastTime = now;

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
        // boxRect is in canvas-pixel space (from clientToCanvas), so the
        // element bbox must be in pixels too.
        const left = el.position.x * GRID_PX;
        const top = el.position.y * GRID_PX;
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
      // Start inertia if velocity is significant
      const vx = panRef.current.velocityX;
      const vy = panRef.current.velocityY;
      panRef.current = null;
      setHostCursor(spaceHeldRef.current ? "grab" : "default");

      if (Math.abs(vx) > 2 || Math.abs(vy) > 2) {
        startInertia(vx, vy);
      } else {
        syncCanvasStateToStore();
      }
    }

    // Spring zoom back to hard bounds if in elastic zone
    const currentZoom = transformRef.current.zoom;
    if (currentZoom < MIN_ZOOM || currentZoom > MAX_ZOOM) {
      springZoomToHard();
    }

    // Reset dragging state
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isBoxSelecting, boxRect, freeformElements, setSelectedElementIds, syncCanvasStateToStore, setHostCursor, startInertia, springZoomToHard, isDragging]);

  const handleWheel = useCallback((e: WheelEvent) => {
    const host = viewportRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const { zoom, panX, panY } = transformRef.current;

    // Ctrl/Cmd + wheel = zoom (with elastic bounds)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      cancelInertia();

      // Smooth zoom: 0.0015 factor gives ~14% change per mouse-wheel notch
      // (deltaY≈100) and stays responsive on trackpad pinch (deltaY≈1-5).
      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = clampZoomElastic(zoom * zoomFactor);
      if (Math.abs(nextZoom - zoom) < 0.001) return;

      const anchorX = e.clientX - rect.left;
      const anchorY = e.clientY - rect.top;
      const canvasAnchorX = (anchorX - panX) / zoom;
      const canvasAnchorY = (anchorY - panY) / zoom;

      transformRef.current.zoom = nextZoom;
      transformRef.current.panX = Math.round(anchorX - canvasAnchorX * nextZoom);
      transformRef.current.panY = Math.round(anchorY - canvasAnchorY * nextZoom);

      applyTransform();
      syncCanvasStateToStore();
      return;
    }

    // Plain wheel/trackpad = pan (with inertia on trackpad)
    e.preventDefault();
    e.stopPropagation();
    cancelInertia();

    transformRef.current.panX -= e.deltaX;
    transformRef.current.panY -= e.deltaY;
    applyTransform();
    syncCanvasStateToStore();
  }, [applyTransform, syncCanvasStateToStore, cancelInertia, clampZoomElastic]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const { editingElementId } = useConductorStore.getState();
    if (editingElementId) return;

    // Space — temporary pan mode (hold)
    if (e.code === "Space" && !e.repeat) {
      e.preventDefault();
      spaceHeldRef.current = true;
      setIsSpaceHeld(true);
      if (!panRef.current?.active) {
        setHostCursor("grab");
      }
      return;
    }

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

    // Zoom shortcuts
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      const { zoom, panX, panY } = transformRef.current;
      const host = viewportRef.current;
      if (!host) return;
      const nextZoom = clampZoomHard(zoom + KEYBOARD_ZOOM_STEP);
      const cx = host.clientWidth / 2;
      const cy = host.clientHeight / 2;
      const canvasX = (cx - panX) / zoom;
      const canvasY = (cy - panY) / zoom;
      transformRef.current.zoom = nextZoom;
      transformRef.current.panX = Math.round(cx - canvasX * nextZoom);
      transformRef.current.panY = Math.round(cy - canvasY * nextZoom);
      applyTransform();
      syncCanvasStateToStore();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") {
      e.preventDefault();
      const { zoom, panX, panY } = transformRef.current;
      const host = viewportRef.current;
      if (!host) return;
      const nextZoom = clampZoomHard(zoom - KEYBOARD_ZOOM_STEP);
      const cx = host.clientWidth / 2;
      const cy = host.clientHeight / 2;
      const canvasX = (cx - panX) / zoom;
      const canvasY = (cy - panY) / zoom;
      transformRef.current.zoom = nextZoom;
      transformRef.current.panX = Math.round(cx - canvasX * nextZoom);
      transformRef.current.panY = Math.round(cy - canvasY * nextZoom);
      applyTransform();
      syncCanvasStateToStore();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      e.preventDefault();
      transformRef.current.zoom = 1;
      applyTransform();
      syncCanvasStateToStore();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "a") {
        e.preventDefault();
        setSelectedElementIds(freeformElements.map((el) => el.id));
        return;
      }
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        void redo();
        return;
      }
      // Don't process tool shortcuts when modifier is held
      return;
    }

    // Tool shortcuts (single letter, no modifier)
    const toolMap: Record<string, string> = {
      v: "select",
      n: "sticky",
      c: "connector",
    };
    const tool = toolMap[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      if (tool === "select") {
        setActiveTool(null);
      } else {
        setActiveTool(tool);
      }
    }
  }, [clearSelection, setActiveTool, freeformElements, setSelectedElementIds, onDeleteElement, undo, redo, applyTransform, syncCanvasStateToStore, clampZoomHard, setHostCursor]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.code === "Space") {
      spaceHeldRef.current = false;
      setIsSpaceHeld(false);
      if (!panRef.current?.active) {
        setHostCursor("default");
      }
    }
  }, [setHostCursor]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/x-conductor-tool") ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const toolType = e.dataTransfer.getData("application/x-conductor-tool");
    if (toolType) {
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
      return;
    }

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    const canvas = clientToCanvas(e.clientX, e.clientY);
    files.forEach((file, i) => {
      const offset = i * 24;
      void dropFileAt(file, canvas.x + offset, canvas.y + offset);
    });
  }, [clientToCanvas, createElementAt, dropFileAt]);

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

  // Consume pending focus requests from the store. centerOnElement()
  // sets pendingFocusElementId; this effect computes the target
  // pan/zoom using the live viewport + transformRef (the store can't
  // see those), applies it, then clears the pending flag.
  const pendingFocusElementId = useConductorStore((s) => s.pendingFocusElementId);
  const clearPendingFocus = useConductorStore((s) => s.clearPendingFocus);
  useEffect(() => {
    if (!pendingFocusElementId) return;
    const el = useConductorStore.getState().elements.find((e) => e.id === pendingFocusElementId);
    if (!el) {
      clearPendingFocus();
      return;
    }
    const host = viewportRef.current;
    if (!host) {
      clearPendingFocus();
      return;
    }
    const elWidthPx = el.position.w * GRID_PX;
    const elHeightPx = el.position.h * GRID_PX;
    // Convert grid-unit x/y to pixels so the center math matches the size
    // math (and the host's pixel-space clientWidth/clientHeight).
    const elCenterX = el.position.x * GRID_PX + elWidthPx / 2;
    const elCenterY = el.position.y * GRID_PX + elHeightPx / 2;
    const zoom = transformRef.current.zoom || 1;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    transformRef.current.panX = Math.round(cw / 2 - elCenterX * zoom);
    transformRef.current.panY = Math.round(ch / 2 - elCenterY * zoom);
    applyTransform();
    syncCanvasStateToStore();
    clearPendingFocus();
  }, [pendingFocusElementId, applyTransform, syncCanvasStateToStore, clearPendingFocus]);

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

      // Ctrl/Cmd+G: group selection (≥2 non-group elements) or ungroup
      // (exactly 1 group selected). Mirrors MultiSelectBar's buttons.
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        const target = e.target as HTMLElement | null;
        const isEditingInput =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);
        if (isEditingInput) return;

        const state = useConductorStore.getState();
        const ids =
          state.selectedElementIds.length > 0
            ? state.selectedElementIds
            : state.selectedElementId
              ? [state.selectedElementId]
              : [];
        const idSet = new Set(ids);
        const selected = state.elements.filter((el) => idSet.has(el.id));
        if (selected.length === 0) return;

        const isUngroupMode =
          selected.length === 1 && selected[0].elementKind === "native/group";

        e.preventDefault();

        if (isUngroupMode && state.activeCanvasId) {
          // Ungroup = delete the group element, keep members.
          const groupEl = selected[0];
          state.removeElement(groupEl.id);
          executeAction({
            action: "element.delete",
            elementId: groupEl.id,
            canvasId: state.activeCanvasId,
          }).catch((err) => {
            state.setUiError(`Ungroup failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          state.clearSelection();
        } else if (selected.length >= 2 && state.activeCanvasId) {
          // Group: filter out groups (no nesting).
          const memberIds = selected
            .filter((el) => el.elementKind !== "native/group")
            .map((el) => el.id);
          if (memberIds.length < 2) return;
          // Group position is metadata only — GroupElement renders its bbox
          // from live member positions. Zero position matches the e2e pattern.
          const groupPosition: CanvasPosition = {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            zIndex: -1,
            rotation: 0,
          };
          createNativeElement(state.activeCanvasId, "group", groupPosition, {
            title: "",
            memberIds,
            bgColor: undefined,
          }).catch((err) => {
            state.setUiError(`Group failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          state.clearSelection();
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

      // Debounced zoom-to-fit when viewport size changes by >8px.
      const dw = Math.abs(cr.width - lastViewportWRef.current);
      const dh = Math.abs(cr.height - lastViewportHRef.current);
      if (dw > 8 || dh > 8) {
        lastViewportWRef.current = cr.width;
        lastViewportHRef.current = cr.height;
        if (zoomFitDebounceRef.current !== null) {
          clearTimeout(zoomFitDebounceRef.current);
        }
        zoomFitDebounceRef.current = setTimeout(() => {
          runZoomToFit();
          zoomFitDebounceRef.current = null;
        }, 150);
      }
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (zoomFitDebounceRef.current !== null) {
        clearTimeout(zoomFitDebounceRef.current);
      }
    };
  }, [setCanvasViewportSize, runZoomToFit]);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    // Wheel events are passive by default in modern browsers. We need to
    // call preventDefault() to stop the page from scrolling while panning
    // / zooming the canvas, so bind with { passive: false }.
    host.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  const cursor = (() => {
    if (isSpaceHeld || spaceHeldRef.current) {
      if (panRef.current?.active) return "grabbing";
      return "grab";
    }
    if (activeTool === "connector") return "crosshair";
    if (parseCreateTool(activeTool)) return "copy";
    if (panRef.current?.active) return "grabbing";
    if (isBoxSelecting) return "crosshair";
    if (dragRef.current) return "grabbing";
    return "default";
  })();

  const handleZoomPillClick = useCallback(() => {
    transformRef.current.zoom = 1;
    applyTransform();
    syncCanvasStateToStore();
  }, [applyTransform, syncCanvasStateToStore]);

  const handleZoomPillWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Manual zoom override — cancel any pending auto-fit so it doesn't
    // fight with the user's zoom. (Does NOT lock — next viewport resize
    // re-triggers auto-fit. Use the lock toggle to disable permanently.)
    if (zoomFitDebounceRef.current !== null) {
      clearTimeout(zoomFitDebounceRef.current);
      zoomFitDebounceRef.current = null;
    }
    const { zoom } = transformRef.current;
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    const nextZoom = clampZoomHard(zoom * zoomFactor);
    if (Math.abs(nextZoom - zoom) < 0.001) return;

    const host = viewportRef.current;
    if (!host) return;
    const cx = host.clientWidth / 2;
    const cy = host.clientHeight / 2;
    const canvasX = (cx - transformRef.current.panX) / zoom;
    const canvasY = (cy - transformRef.current.panY) / zoom;
    transformRef.current.zoom = nextZoom;
    transformRef.current.panX = Math.round(cx - canvasX * nextZoom);
    transformRef.current.panY = Math.round(cy - canvasY * nextZoom);
    applyTransform();
    syncCanvasStateToStore();
  }, [applyTransform, syncCanvasStateToStore, clampZoomHard]);

  return (
    <div
      className="relative h-full overflow-hidden canvas-area conductor-canvas-surface"
      ref={viewportRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
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
        className="relative canvas-inner"
        ref={canvasElRef}
        style={{
          width: MIN_CANVAS_WIDTH,
          height: MIN_CANVAS_HEIGHT,
          transformOrigin: "0 0",
          transform: "translate(0px, 0px) scale(1)",
        }}
      >
        {elements.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p style={{ color: "var(--text-tertiary)", fontSize: 14 }}>This canvas is empty — pick a tool from the left to start</p>
          </div>
        )}

        {hasFreeformElements ? (
          <>
            <GroupLayer elements={elements} />
            <div style={{ zIndex: 1, position: "absolute", inset: 0, pointerEvents: "none" }}>
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
          <div style={{ zIndex: 1, position: "absolute", inset: 0, pointerEvents: "none" }}>
            <FreeformLayer
              elements={freeformElements}
              readOnly={readOnly}
              onPositionChange={onPositionChange}
              onDeleteElement={onDeleteElement}
            />
          </div>
        )}

        {boxRect && boxRect.w > 2 && boxRect.h > 2 && (
          <div
            style={{
              position: "absolute",
              left: boxRect.x,
              top: boxRect.y,
              width: boxRect.w,
              height: boxRect.h,
              border: "1.5px solid var(--conductor-accent)",
              backgroundColor: "var(--conductor-accent-soft)",
              borderRadius: 4,
              pointerEvents: "none",
              zIndex: 10000,
            }}
          />
        )}

        {alignmentGuides.map((guide, index) => (
          <div
            key={`${guide.type}-${guide.value}-${index}`}
            className={`conductor-guide-line ${guide.type}`}
            style={
              guide.type === "vertical"
                ? { left: guide.value * GRID_PX, top: 0, height: "100%" }
                : { left: 0, top: guide.value * GRID_PX, width: "100%" }
            }
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
              stroke="var(--conductor-accent)"
              strokeWidth={2}
              strokeDasharray="6 3"
              strokeLinecap="round"
            />
            <circle
              cx={connectorDraft.sourcePx.x}
              cy={connectorDraft.sourcePx.y}
              r={5}
              fill="var(--canvas-bg)"
              stroke="var(--conductor-accent)"
              strokeWidth={2}
            />
          </svg>
        )}
      </div>

      {/* Zoom indicator pill — bottom right. Marked with data-capture-ignore
          so canvas_capture screenshots omit it; otherwise it can overlap
          elements in the bottom-right corner. */}
      <div
        data-capture-ignore
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <button
          className="zoom-lock-toggle"
          title={userZoomLockRef.current ? "Unlock auto-fit" : "Lock zoom (disable auto-fit)"}
          onClick={() => {
            userZoomLockRef.current = !userZoomLockRef.current;
            // Force a re-render to update the icon.
            setZoomDisplay(transformRef.current.zoom);
          }}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "2px 6px",
            cursor: "pointer",
            color: userZoomLockRef.current ? "var(--conductor-accent)" : "var(--text-secondary)",
          }}
        >
          {userZoomLockRef.current ? "🔒" : "🔓"}
        </button>
        <div
          className="conductor-zoom-pill"
          onClick={handleZoomPillClick}
          onWheel={handleZoomPillWheel}
          title="Click to reset to 100%, scroll to zoom"
        >
          {Math.round(zoomDisplay * 100)}%
        </div>
      </div>

      <div data-capture-ignore>
        <StylePanel />
      </div>
      <div data-capture-ignore>
        <MultiSelectBar />
      </div>
    </div>
  );
};
