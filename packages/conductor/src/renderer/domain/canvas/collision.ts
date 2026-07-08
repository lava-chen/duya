/**
 * Passive push-aside collision.
 *
 * When the dragged element overlaps another, the other element is
 * pushed along the drag direction by the overlap amount plus a gap.
 * Locked elements (metadata.locked === true) are immovable obstacles
 * and never pushed.
 *
 * Coordinates: grid units.
 */
import type { CanvasElement } from '../../types/conductor';
import type { CanvasSpatialIndex } from './spatialIndex';

export interface MovedElement {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface PushAsideResult {
  moved: MovedElement[];
}

export interface PushAsideOptions {
  /** Grid units. Gap kept between dragged and pushed elements. */
  gap: number;
  /** Whether to recursively push elements hit by pushed elements. */
  cascade: boolean;
  /** Max cascade depth. Default 3. */
  maxDepth: number;
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function elementBBox(el: CanvasElement): BBox {
  return {
    minX: el.position.x,
    minY: el.position.y,
    maxX: el.position.x + el.position.w,
    maxY: el.position.y + el.position.h,
  };
}

function intersects(a: BBox, b: BBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function isLocked(el: CanvasElement): boolean {
  return (el.metadata as { locked?: boolean }).locked === true;
}

interface QueueItem {
  element: CanvasElement;
  depth: number;
  /** BBox of the pusher AFTER it moved. Overlap is computed against this. */
  pusherBBox: BBox;
}

export function pushAside(
  dragged: CanvasElement,
  drag: { dx: number; dy: number },
  index: CanvasSpatialIndex,
  options: PushAsideOptions,
): PushAsideResult {
  const moved: MovedElement[] = [];
  const movedMap = new Map<string, MovedElement>();
  const draggedBBox = elementBBox(dragged);

  // If drag direction is zero, no push.
  if (drag.dx === 0 && drag.dy === 0) {
    return { moved };
  }

  // Normalize drag direction to a unit vector for projection.
  const mag = Math.hypot(drag.dx, drag.dy);
  const ux = drag.dx / mag;
  const uy = drag.dy / mag;

  // Find elements intersecting the dragged bbox.
  const candidates = index.search(draggedBBox).filter(el => el.id !== dragged.id && !isLocked(el));

  // Recursive cascade. For depth 1, the pusher is the dragged element itself
  // (which does not move in this model), so pusherBBox == draggedBBox.
  const queue: QueueItem[] = candidates.map(el => ({
    element: el,
    depth: 1,
    pusherBBox: draggedBBox,
  }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { element, depth, pusherBBox } = queue.shift()!;
    if (visited.has(element.id)) continue;
    if (depth > options.maxDepth) continue;

    const elBBox = elementBBox(element);
    if (!intersects(pusherBBox, elBBox)) continue;
    visited.add(element.id);

    // Compute overlap on each axis against the pusher's bbox.
    const overlapX = Math.min(pusherBBox.maxX, elBBox.maxX) - Math.max(pusherBBox.minX, elBBox.minX);
    const overlapY = Math.min(pusherBBox.maxY, elBBox.maxY) - Math.max(pusherBBox.minY, elBBox.minY);

    // Push along drag direction. If drag is mostly horizontal, push horizontally;
    // else vertically.
    const horizontal = Math.abs(ux) >= Math.abs(uy);
    const pushX = horizontal ? (ux > 0 ? overlapX + options.gap : -(overlapX + options.gap)) : 0;
    const pushY = horizontal ? 0 : (uy > 0 ? overlapY + options.gap : -(overlapY + options.gap));

    const fromX = element.position.x;
    const fromY = element.position.y;
    const toX = fromX + pushX;
    const toY = fromY + pushY;

    const movedEl: MovedElement = { id: element.id, fromX, fromY, toX, toY };
    moved.push(movedEl);
    movedMap.set(element.id, movedEl);

    if (options.cascade) {
      // Find elements hit by the pushed element's new bbox.
      const pushedBBox: BBox = {
        minX: toX,
        minY: toY,
        maxX: toX + element.position.w,
        maxY: toY + element.position.h,
      };
      const secondary = index.search(pushedBBox).filter(el =>
        el.id !== dragged.id && el.id !== element.id && !isLocked(el) && !visited.has(el.id),
      );
      // Chain semantics: only carry along elements that were ALREADY in contact
      // with the current element's OLD bbox. This makes depth represent the
      // chain-hop count (a->b->c->...), so maxDepth caps the chain length
      // rather than the BFS breadth.
      for (const next of secondary) {
        if (intersects(elBBox, elementBBox(next))) {
          queue.push({
            element: next,
            depth: depth + 1,
            pusherBBox: pushedBBox,
          });
        }
      }
    }
  }

  return { moved };
}
