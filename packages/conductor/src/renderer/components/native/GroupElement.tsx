"use client";

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { executeAction } from "../..//ipc/conductor-ipc";
import { canvasTransformState } from "../CanvasArea";
import { GRID_PX } from "../../domain/canvas/units";

const FRAME_PADDING_PX = 12;
const HANDLE_SIZE = 10;

interface GroupBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute the bounding box (in pixel coordinates) of a group from its
 * member elements. Returns null if the group has no resolvable members.
 */
export function computeGroupBbox(
  memberIds: string[],
  elements: CanvasElement[],
): GroupBbox | null {
  if (!memberIds || memberIds.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = 0;
  for (const id of memberIds) {
    const el = elements.find((e) => e.id === id);
    if (!el) continue;
    const left = el.position.x * GRID_PX;
    const top = el.position.y * GRID_PX;
    const right = left + el.position.w * GRID_PX;
    const bottom = top + el.position.h * GRID_PX;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
    found += 1;
  }
  if (found === 0) return null;
  return {
    x: minX - FRAME_PADDING_PX,
    y: minY - FRAME_PADDING_PX,
    w: maxX - minX + FRAME_PADDING_PX * 2,
    h: maxY - minY + FRAME_PADDING_PX * 2,
  };
}

export const GroupElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const elements = useConductorStore((state) => state.elements);
  const updateElement = useConductorStore((state) => state.updateElement);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const memberIds = (element.config.memberIds as string[] | undefined) ?? [];
  const title = (element.config.title as string | undefined) ?? "";
  const bgColor = element.config.bgColor as string | undefined;
  const locked = element.metadata.locked === true;

  // Real-time bbox: re-computes whenever elements change (members dragged, etc).
  const bbox = useMemo(() => computeGroupBbox(memberIds, elements), [memberIds, elements]);

  const isSelected = selectedElementId === element.id;

  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    origPositions: Map<string, { x: number; y: number }>;
    rafId: number | null;
    lastMouseX: number;
    lastMouseY: number;
  } | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Only select the group when the click lands on the frame itself,
    // not on a member element. Member elements sit above the group layer,
    // so they receive their own clicks first and call stopPropagation.
    e.stopPropagation();
    setSelectedElementId(element.id);
  }, [element.id, setSelectedElementId]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (locked) return;
    if (!bbox) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedElementId(element.id);

    const origPositions = new Map<string, { x: number; y: number }>();
    for (const id of memberIds) {
      const el = elements.find((it) => it.id === id);
      if (el && el.metadata.locked !== true) origPositions.set(id, { x: el.position.x, y: el.position.y });
    }

    dragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      origPositions,
      rafId: null,
      lastMouseX: e.clientX,
      lastMouseY: e.clientY,
    };
  }, [bbox, elements, locked, memberIds, setSelectedElementId]);

  useEffect(() => {
    const flushDragFrame = () => {
      const r = dragRef.current;
      if (!r) return;
      r.rafId = null;

      const zoom = canvasTransformState.zoom || 1;
      // `dx`/`dy` are screen-pixel deltas; the canvas model persists x/y
      // in grid units (1 unit = 80 px), so divide before applying.
      const dxGrid = (r.lastMouseX - r.startMouseX) / zoom / GRID_PX;
      const dyGrid = (r.lastMouseY - r.startMouseY) / zoom / GRID_PX;
      if (dxGrid === 0 && dyGrid === 0) return;

      // Apply delta to every member locally for snappy feedback.
      for (const id of memberIds) {
        const orig = r.origPositions.get(id);
        if (!orig) continue;
        updateElement(id, {
          position: {
            ...(elements.find((el) => el.id === id)?.position ?? { w: 0, h: 0, zIndex: 0, rotation: 0 }),
            x: orig.x + dxGrid,
            y: orig.y + dyGrid,
          },
        } as Partial<CanvasElement>);
      }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const r = dragRef.current;
      if (!r) return;
      r.lastMouseX = e.clientX;
      r.lastMouseY = e.clientY;
      if (r.rafId === null) {
        r.rafId = window.requestAnimationFrame(flushDragFrame);
      }
    };

    const handleGlobalMouseUp = () => {
      const r = dragRef.current;
      if (!r) return;
      if (r.rafId !== null) {
        window.cancelAnimationFrame(r.rafId);
        flushDragFrame();
      }
      dragRef.current = null;

      // Persist final positions via element.move for each member.
      if (!activeCanvasId) return;
      const finalDx = (r.lastMouseX - r.startMouseX) / (canvasTransformState.zoom || 1);
      const finalDy = (r.lastMouseY - r.startMouseY) / (canvasTransformState.zoom || 1);
      if (finalDx === 0 && finalDy === 0) return;
      for (const id of memberIds) {
        const orig = r.origPositions.get(id);
        if (!orig) continue;
        const el = useConductorStore.getState().elements.find((it) => it.id === id);
        if (!el) continue;
        executeAction({
          action: "element.move",
          elementId: id,
          canvasId: activeCanvasId,
          position: el.position,
        }).catch((err) => {
          setUiError(`Move group member failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [activeCanvasId, elements, memberIds, setUiError, updateElement]);

  if (!bbox) return null;

  const frameStyle: React.CSSProperties = {
    position: "absolute",
    left: bbox.x,
    top: bbox.y,
    width: bbox.w,
    height: bbox.h,
    border: `${isSelected ? 2 : 1.5}px ${isSelected ? "solid" : "dashed"} var(--conductor-accent)`,
    borderRadius: 12,
    background: bgColor ? `${bgColor}` : "transparent",
    opacity: bgColor ? 0.08 : 1,
    pointerEvents: "auto",
    cursor: isSelected && !locked ? "grab" : "default",
    transition: "border var(--motion-duration-micro) var(--motion-smooth)",
    zIndex: 0,
  };

  const overlayStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: 12,
    background: "transparent",
    pointerEvents: "auto",
  };

  const titleStyle: React.CSSProperties = {
    position: "absolute",
    top: -10,
    left: 8,
    padding: "1px 8px",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--conductor-accent)",
    background: "var(--canvas-bg)",
    borderRadius: 4,
    border: "1px solid var(--conductor-accent)",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    maxWidth: bbox.w - 16,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: "var(--conductor-accent)",
    border: "2px solid var(--canvas-bg)",
    borderRadius: "50%",
    zIndex: 10,
    pointerEvents: "auto",
  };

  return (
    <div
      className="conductor-group"
      style={frameStyle}
      onClick={handleClick}
      onMouseDown={handleDragStart}
    >
      <div style={overlayStyle} />
      {title && <div style={titleStyle}>{title}</div>}

      {isSelected && !locked && (
        <>
          <div style={{ ...handleStyle, top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nwse-resize" }} />
          <div style={{ ...handleStyle, top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nesw-resize" }} />
          <div style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2, cursor: "nesw-resize" }} />
          <div style={{ ...handleStyle, bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2, cursor: "nwse-resize" }} />
        </>
      )}
    </div>
  );
};
