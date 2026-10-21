/**
 * Viewport-aware packing and zoom-to-fit.
 *
 * - zoomToFit: compute zoom + pan to fit all elements in viewport.
 * - viewportAwarePack: place new elements into the viewport using
 *   bin-pack, respecting priority.
 *
 * Pure functions. Coordinates: grid units.
 */
import type { CanvasElement, CanvasPosition } from '../../../types/conductor';
import { binPack, type BinPackOptions, type LayoutResult } from './binPack';

export type Priority = 'high' | 'mid' | 'low';

export interface ViewportFitOptions {
  viewport: { width: number; height: number };
  minZoom: number;
  maxZoom: number;
  /** Grid units of padding around the bbox. */
  padding: number;
  respectMinSize: boolean;
}

export interface ZoomToFitResult {
  zoom: number;
  panX: number;
  panY: number;
}

export function zoomToFit(
  elements: ReadonlyArray<CanvasElement>,
  options: ViewportFitOptions,
): ZoomToFitResult {
  if (elements.length === 0) {
    return { zoom: 1, panX: 0, panY: 0 };
  }

  // Compute bbox.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.position.x);
    minY = Math.min(minY, el.position.y);
    maxX = Math.max(maxX, el.position.x + el.position.w);
    maxY = Math.max(maxY, el.position.y + el.position.h);
  }
  const bboxW = maxX - minX + options.padding * 2;
  const bboxH = maxY - minY + options.padding * 2;

  const zoomX = options.viewport.width / bboxW;
  const zoomY = options.viewport.height / bboxH;
  let zoom = Math.min(zoomX, zoomY);
  zoom = Math.max(options.minZoom, Math.min(options.maxZoom, zoom));

  // Center.
  const panX = (options.viewport.width - bboxW * zoom) / 2 - (minX - options.padding) * zoom;
  const panY = (options.viewport.height - bboxH * zoom) / 2 - (minY - options.padding) * zoom;

  return { zoom, panX, panY };
}

export interface ViewportAwarePackOptions extends BinPackOptions {
  priorityWeight: Record<Priority, number>;
}

export function viewportAwarePack(
  existing: ReadonlyArray<CanvasElement>,
  incoming: ReadonlyArray<CanvasElement>,
  options: ViewportAwarePackOptions,
): LayoutResult[] {
  if (incoming.length === 0) return [];

  const sorted = [...incoming].sort((a, b) => {
    const pa = (a.metadata as { priority?: Priority }).priority ?? 'mid';
    const pb = (b.metadata as { priority?: Priority }).priority ?? 'mid';
    return options.priorityWeight[pa] - options.priorityWeight[pb];
  });

  // Treat existing as locked obstacles by marking them locked for the
  // bin-pack call. We pass a synthetic element list: existing (as locked)
  // followed by incoming (free). preserveLocked=true keeps existing in
  // place and carves them out of the free space.
  const existingAsLocked = existing.map(el => ({
    ...el,
    metadata: { ...el.metadata, locked: true },
  }));
  const packed = binPack([...existingAsLocked, ...sorted], {
    viewport: options.viewport,
    gap: options.gap,
    preserveLocked: true,
    maxFreeRects: options.maxFreeRects,
  });

  // Return only the incoming elements' results.
  const incomingIds = new Set(incoming.map(e => e.id));
  return packed.filter(r => incomingIds.has(r.id));
}
