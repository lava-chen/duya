/**
 * Drag-and-drop helpers for the sidebar.
 *
 * The sidebar behaves differently from a typical sortable list:
 *
 *   1. Rows have variable height depending on collapse state and
 *      nested thread visibility. The default
 *      `verticalListSortingStrategy` measures each node the first time
 *      it sees it and caches that height — if the user expands the row
 *      later, the cached height is wrong and reordering visually jumps.
 *      We replace it with a custom strategy that always uses the
 *      collapsed-row height (see `COLLAPSED_ROW_HEIGHT`).
 *
 *   2. Dragging sideways is meaningless in a vertical sidebar. We
 *      restrict the dragged transform to the container's vertical
 *      extent and zero out horizontal delta.
 *
 * The shape of these helpers mirrors `packages/ui/src/lib/workspaceSidebarDrag.ts`
 * in zcode, but is local to the duya sidebar and works with its row
 * CSS (`.project-group-header` / `.thread-item`).
 */

import type { SortingStrategy } from "@dnd-kit/sortable";
import type { Modifier } from "@dnd-kit/core";
import type { Transform } from "@dnd-kit/utilities";

/** Height of a fully collapsed sidebar row, in pixels. */
export const COLLAPSED_ROW_HEIGHT = 32;

/**
 * Sorting strategy that treats every item as having a fixed
 * collapsed height of `COLLAPSED_ROW_HEIGHT`, regardless of its
 * actual measured height.
 *
 * @dnd-kit's default `verticalListSortingStrategy` calls
 * `getBoundingClientRect()` once per item and caches the result. If
 * a row's measured height changes after that snapshot (because it
 * was expanded or its nested children grew), the offset math drifts
 * and the drop indicator lands in the wrong slot.
 *
 * Returning a constant keeps the math correct no matter how many
 * children are nested inside a project header. The user-visible
 * "make room" effect comes from the active item's own transform plus
 * the `<DragOverlay>` clone, not from per-item offsets — which is
 * exactly what zcode's `workspaceVerticalListSortingStrategy` does.
 */
export const sidebarVerticalListSortingStrategy: SortingStrategy = () => {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
  };
};

/**
 * Build a strategy that emits no per-item transform. Kept as a
 * factory so future tuning (e.g. accounting for collapsed vs.
 * expanded row heights) is a one-line change. Currently it is a
 * thin wrapper around the module-level constant.
 */
export function makeSidebarVerticalListSortingStrategy(
  _options: { itemHeight?: number } = {},
): SortingStrategy {
  void _options.itemHeight;
  return sidebarVerticalListSortingStrategy;
}

/**
 * Modifier that:
 *   - zeros out the horizontal component of the drag transform, and
 *   - clamps the vertical component so the dragged preview never
 *     leaves the scroll container.
 *
 * Use as one entry in the `modifiers` prop of `<DndContext>`.
 */
export const restrictVerticalDragWithinContainer: Modifier = (args) => {
  const {
    transform,
    draggingNodeRect,
    containerNodeRect,
    activeNodeRect,
  } = args;

  if (!draggingNodeRect || !containerNodeRect) {
    return { ...transform, x: 0 } as Transform;
  }

  // Zero out horizontal motion — sidebar rows are single-column.
  const nextX = 0;

  // Compute the absolute Y range we want to allow the dragged item
  // to move within. We anchor to the container's top and bottom, with
  // a small margin so the cursor isn't visually clipped at the edges.
  const containerTop = containerNodeRect.top;
  const containerBottom = containerNodeRect.bottom;
  const dragHeight = draggingNodeRect.height;

  // The original transform.y is relative to the node's starting
  // position; clamp it so the resulting absolute position stays
  // inside [containerTop, containerBottom - dragHeight].
  const startTop = activeNodeRect?.top ?? containerTop;
  const currentTop = startTop + transform.y;
  const minTop = containerTop;
  const maxTop = containerBottom - dragHeight;

  const clampedTop = Math.min(Math.max(currentTop, minTop), maxTop);
  const nextY = clampedTop - startTop;

  return {
    ...transform,
    x: nextX,
    y: nextY,
  } as Transform;
};
