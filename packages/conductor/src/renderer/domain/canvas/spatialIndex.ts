/**
 * R-tree spatial index for canvas elements.
 *
 * Single source of truth for spatial queries (hit-test, alignment-candidate
 * pruning, and explicit layout obstacles). The UI layer reads from this index
 * instead of DOM `closest()` to avoid layout thrash on mousemove.
 *
 * Coordinates: all positions are in **grid units** (1 unit = 80px).
 * The index treats them as plain numbers — it does not care about
 * the unit, only the rectangle math.
 */
import RBush from 'rbush';
import type { CanvasElement } from '../../types/conductor';

interface RBushNode {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  element: CanvasElement;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class CanvasSpatialIndex {
  private tree: RBush<RBushNode> = new RBush();
  private idToNode: Map<string, RBushNode> = new Map();

  /** Rebuild from elements array. O(n log n). Call on canvas load / external sync. */
  rebuild(elements: ReadonlyArray<CanvasElement>): void {
    this.tree.clear();
    this.idToNode.clear();
    for (const element of elements) {
      this.insertInternal(element);
    }
  }

  /** Insert or update one element. O(log n). Call on element create/move/resize. */
  upsert(element: CanvasElement): void {
    const existing = this.idToNode.get(element.id);
    if (existing) {
      this.tree.remove(existing);
    }
    this.insertInternal(element);
  }

  /** Remove one element. O(log n). */
  remove(id: string): void {
    const node = this.idToNode.get(id);
    if (node) {
      this.tree.remove(node);
      this.idToNode.delete(id);
    }
  }

  /** Query elements intersecting bbox. O(log n + k). */
  search(bbox: BBox): CanvasElement[] {
    return this.tree.search(bbox).map(node => node.element);
  }

  /**
   * Query topmost element at point with fuzzy padding. O(log n + k).
   * Returns the element with the highest zIndex among candidates.
   */
  hitTest(point: { x: number; y: number }, fuzzyPadding: number): CanvasElement | null {
    const hits = this.tree.search({
      minX: point.x - fuzzyPadding,
      minY: point.y - fuzzyPadding,
      maxX: point.x + fuzzyPadding,
      maxY: point.y + fuzzyPadding,
    });
    if (hits.length === 0) return null;
    let best = hits[0];
    for (const node of hits) {
      if (node.element.position.zIndex > best.element.position.zIndex) {
        best = node;
      }
    }
    return best.element;
  }

  private insertInternal(element: CanvasElement): void {
    const { x, y, w, h } = element.position;
    const node: RBushNode = {
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h,
      element,
    };
    this.tree.insert(node);
    this.idToNode.set(element.id, node);
  }
}
