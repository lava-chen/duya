/**
 * Alignment-first snap policy.
 *
 * Replaces the release-time grid snap. When the dragged element's
 * edges or center fall within `threshold` of another element's
 * edges/center, snap to that alignment. Otherwise, the element
 * stays exactly where the user released it (free placement).
 *
 * Replaces both `computeAlignmentSnap` in CanvasArea.tsx and
 * `snapToAlignmentGuides` in alignment-guides.ts.
 *
 * Coordinates: grid units.
 */
import type { CanvasElement } from '../../types/conductor';

export interface AlignmentGuide {
  type: 'vertical' | 'horizontal';
  value: number;
  alignedTo: 'left' | 'right' | 'centerX' | 'top' | 'bottom' | 'centerY';
}

export type SnapResult =
  | { kind: 'alignment'; x: number; y: number; guides: AlignmentGuide[] }
  | { kind: 'free'; x: number; y: number; guides: [] };

export interface ComputeSnapOptions {
  /** Grid units. The existing ALIGN_THRESHOLD=8 was in grid units already. */
  threshold: number;
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function getBounds(el: CanvasElement): Bounds {
  const { x, y, w, h } = el.position;
  return {
    left: x,
    right: x + w,
    top: y,
    bottom: y + h,
    centerX: x + w / 2,
    centerY: y + h / 2,
  };
}

interface BestSnap {
  delta: number;
  guide: AlignmentGuide;
}

export function computeSnap(
  dragged: CanvasElement,
  others: ReadonlyArray<CanvasElement>,
  options: ComputeSnapOptions,
): SnapResult {
  const movingBounds = getBounds(dragged);
  let bestX: BestSnap | null = null;
  let bestY: BestSnap | null = null;

  for (const other of others) {
    if (other.id === dragged.id) continue;
    const otherBounds = getBounds(other);

    const verticalChecks: Array<{ moving: number; other: number; type: AlignmentGuide['alignedTo'] }> = [
      { moving: movingBounds.left, other: otherBounds.left, type: 'left' },
      { moving: movingBounds.right, other: otherBounds.right, type: 'right' },
      { moving: movingBounds.centerX, other: otherBounds.centerX, type: 'centerX' },
      { moving: movingBounds.left, other: otherBounds.right, type: 'left' },
      { moving: movingBounds.right, other: otherBounds.left, type: 'right' },
    ];
    for (const check of verticalChecks) {
      const delta = check.other - check.moving;
      if (Math.abs(delta) <= options.threshold) {
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, guide: { type: 'vertical', value: check.other, alignedTo: check.type } };
        }
      }
    }

    const horizontalChecks: Array<{ moving: number; other: number; type: AlignmentGuide['alignedTo'] }> = [
      { moving: movingBounds.top, other: otherBounds.top, type: 'top' },
      { moving: movingBounds.bottom, other: otherBounds.bottom, type: 'bottom' },
      { moving: movingBounds.centerY, other: otherBounds.centerY, type: 'centerY' },
      { moving: movingBounds.top, other: otherBounds.bottom, type: 'top' },
      { moving: movingBounds.bottom, other: otherBounds.top, type: 'bottom' },
    ];
    for (const check of horizontalChecks) {
      const delta = check.other - check.moving;
      if (Math.abs(delta) <= options.threshold) {
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, guide: { type: 'horizontal', value: check.other, alignedTo: check.type } };
        }
      }
    }
  }

  if (!bestX && !bestY) {
    return { kind: 'free', x: dragged.position.x, y: dragged.position.y, guides: [] };
  }

  let snappedX = dragged.position.x;
  let snappedY = dragged.position.y;
  const guides: AlignmentGuide[] = [];

  if (bestX) {
    switch (bestX.guide.alignedTo) {
      case 'left':
        snappedX = bestX.guide.value;
        break;
      case 'right':
        snappedX = bestX.guide.value - dragged.position.w;
        break;
      case 'centerX':
        snappedX = bestX.guide.value - dragged.position.w / 2;
        break;
    }
    guides.push(bestX.guide);
  }

  if (bestY) {
    switch (bestY.guide.alignedTo) {
      case 'top':
        snappedY = bestY.guide.value;
        break;
      case 'bottom':
        snappedY = bestY.guide.value - dragged.position.h;
        break;
      case 'centerY':
        snappedY = bestY.guide.value - dragged.position.h / 2;
        break;
    }
    guides.push(bestY.guide);
  }

  return { kind: 'alignment', x: snappedX, y: snappedY, guides };
}
