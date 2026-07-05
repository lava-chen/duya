"use client";

import { useMemo } from "react";
import { useConductorStore } from "../stores/conductor-store";
import { createNativeElement, executeAction } from "../ipc/conductor-ipc";
import type { CanvasElement, CanvasPosition } from "../types/conductor";
import { GRID_PX } from "../domain/canvas/units";
// Approximate bar width (two buttons + divider + padding). Used only for
// horizontal viewport clamping; the actual width is determined by content.
const BAR_WIDTH = 200;
// Vertical gap between the bar and the selection bbox.
const BAR_GAP = 12;
// Bar height estimate, used by the flip-below threshold.
const BAR_HEIGHT_ESTIMATE = 36;
// Minimum space above the bbox (in screen px) before the bar flips below.
const FLIP_BELOW_THRESHOLD = BAR_HEIGHT_ESTIMATE + BAR_GAP + 16;

interface SelectionBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Compute the canvas-coordinate bounding box of a set of elements.
 * Returns null if the list is empty. Result is in **pixels** — callers
 * (viewport clamping, bbox-vs-viewport comparison) all work in pixel space.
 */
function computeSelectionBbox(elements: CanvasElement[]): SelectionBbox | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const left = el.position.x * GRID_PX;
    const top = el.position.y * GRID_PX;
    const right = left + el.position.w * GRID_PX;
    const bottom = top + el.position.h * GRID_PX;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  return { minX, minY, maxX, maxY };
}

export function MultiSelectBar() {
  const elements = useConductorStore((state) => state.elements);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const canvasScrollX = useConductorStore((state) => state.canvasScrollX);
  const canvasScrollY = useConductorStore((state) => state.canvasScrollY);
  const canvasViewportW = useConductorStore((state) => state.canvasViewportW);
  const canvasViewportH = useConductorStore((state) => state.canvasViewportH);
  const canvasZoom = useConductorStore((state) => state.canvasZoom);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const removeElement = useConductorStore((state) => state.removeElement);
  const clearSelection = useConductorStore((state) => state.clearSelection);
  const setUiError = useConductorStore((state) => state.setUiError);

  const selectedElements = useMemo(() => {
    const ids =
      selectedElementIds.length > 0
        ? selectedElementIds
        : selectedElementId
          ? [selectedElementId]
          : [];
    const idSet = new Set(ids);
    return elements.filter((el) => idSet.has(el.id));
  }, [elements, selectedElementId, selectedElementIds]);

  const isUngroupMode =
    selectedElements.length === 1 &&
    selectedElements[0]?.elementKind === "native/group";

  // Show when: ≥2 elements selected (Group + Delete), or exactly 1 group
  // selected (Ungroup + Delete). Otherwise hide.
  const visible =
    selectedElements.length >= 2 || isUngroupMode;

  const bbox = useMemo(
    () => computeSelectionBbox(selectedElements),
    [selectedElements],
  );

  const position = useMemo(() => {
    if (!visible || !bbox) return null;
    const zoom = canvasZoom > 0 ? canvasZoom : 1;
    const centerX = ((bbox.minX + bbox.maxX) / 2) * zoom + canvasScrollX;
    const topY = bbox.minY * zoom + canvasScrollY;
    const bottomY = bbox.maxY * zoom + canvasScrollY;

    const clampedLeft = Math.max(
      16,
      Math.min(centerX - BAR_WIDTH / 2, Math.max(16, canvasViewportW - BAR_WIDTH - 16)),
    );

    // If there isn't enough room above the bbox, flip the bar below the bbox.
    const spaceAbove = topY;
    const placeBelow = spaceAbove < FLIP_BELOW_THRESHOLD;
    const top = placeBelow
      ? bottomY + BAR_GAP
      : Math.max(16, topY - BAR_GAP - BAR_HEIGHT_ESTIMATE);

    // Clamp top to viewport (allow the bar to scroll off the bottom edge
    // naturally if the selection is very tall — better than overlapping the
    // selection itself).
    const clampedTop = Math.max(16, Math.min(top, canvasViewportH - BAR_HEIGHT_ESTIMATE - 16));

    return { left: clampedLeft, top: clampedTop };
  }, [bbox, visible, canvasScrollX, canvasScrollY, canvasViewportW, canvasViewportH, canvasZoom]);

  if (!visible || !bbox || !position) return null;

  // Non-group elements eligible to become group members (groups cannot be
  // nested).
  const memberCandidates = selectedElements.filter(
    (el) => el.elementKind !== "native/group",
  );
  const canGroup = memberCandidates.length >= 2;

  const handleGroup = async () => {
    if (!activeCanvasId || !bbox || !canGroup) return;
    const memberIds = memberCandidates.map((el) => el.id);
    // Group position metadata: bbox of the initial members. GroupElement
    // renders its own bbox from live member positions, so this is purely
    // stored metadata. `bbox` is in pixels — convert back to grid units so
    // the persisted `position` matches the canvas model.
    const groupPosition: CanvasPosition = {
      x: bbox.minX / GRID_PX,
      y: bbox.minY / GRID_PX,
      w: (bbox.maxX - bbox.minX) / GRID_PX,
      h: (bbox.maxY - bbox.minY) / GRID_PX,
      zIndex: -1,
      rotation: 0,
    };
    try {
      await createNativeElement(activeCanvasId, "group", groupPosition, {
        title: "",
        memberIds,
        bgColor: undefined,
      });
      clearSelection();
    } catch (err) {
      setUiError(`Group failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUngroup = async () => {
    if (!activeCanvasId || !isUngroupMode) return;
    const groupEl = selectedElements[0];
    if (!groupEl) return;
    // Ungroup = delete the group element. Members are NOT deleted — they
    // remain in place at their current positions.
    removeElement(groupEl.id);
    try {
      await executeAction({
        action: "element.delete",
        elementId: groupEl.id,
        canvasId: activeCanvasId,
      });
    } catch (err) {
      setUiError(`Ungroup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearSelection();
  };

  const handleDelete = async () => {
    if (!activeCanvasId) return;
    for (const el of selectedElements) {
      removeElement(el.id);
    }
    try {
      await Promise.all(
        selectedElements.map((el) =>
          executeAction({
            action: "element.delete",
            elementId: el.id,
            canvasId: activeCanvasId,
          }),
        ),
      );
    } catch (err) {
      setUiError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearSelection();
  };

  return (
    <div
      className="absolute z-[43] pointer-events-auto"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="conductor-panel flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--sidebar-bg)] px-1.5 py-1 shadow-[0_16px_40px_rgba(0,0,0,0.32)]">
        {isUngroupMode ? (
          <button
            type="button"
            onClick={handleUngroup}
            title="Ungroup (delete the group frame, keep members)"
            className="conductor-tool-button flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            Ungroup
          </button>
        ) : (
          <button
            type="button"
            onClick={handleGroup}
            disabled={!canGroup}
            title={
              canGroup
                ? "Group selected elements"
                : "Need at least 2 non-group elements (groups cannot be nested)"
            }
            className="conductor-tool-button flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Group
          </button>
        )}
        <span className="h-5 w-px bg-[var(--conductor-border)]" aria-hidden="true" />
        <button
          type="button"
          onClick={handleDelete}
          title="Delete selected"
          className="conductor-tool-button flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
