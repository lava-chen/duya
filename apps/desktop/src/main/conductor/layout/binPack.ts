/**
 * Guillotine bin-packing.
 *
 * Packs elements into a viewport using the Guillotine algorithm with
 * top-row-first selection with best-short-side fit (BSSF) tiebreaking.
 * Free-rectangle list is capped
 * at `maxFreeRects` (smallest discarded) to prevent exponential growth.
 *
 * Pure function: returns new positions, does not mutate inputs.
 *
 * Coordinates: grid units.
 */
import type { LayoutElement, LayoutResult } from './types';

export interface BinPackOptions {
  viewport: { width: number; height: number };
  /** Grid units between elements. */
  gap: number;
  /** If true, locked elements keep their positions and act as obstacles. */
  preserveLocked: boolean;
  /** Cap on free-rectangle list size. Default 32. */
  maxFreeRects: number;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function isLocked(el: LayoutElement): boolean {
  return (el.metadata as { locked?: boolean }).locked === true;
}

function intersects(a: FreeRect, b: PlacedRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function binPack(
  elements: ReadonlyArray<LayoutElement>,
  options: BinPackOptions,
): LayoutResult[] {
  if (elements.length === 0) return [];

  const results: LayoutResult[] = [];
  const placed: PlacedRect[] = [];
  const obstacles: PlacedRect[] = [];

  // Separate locked (obstacles) from free elements.
  const freeElements: LayoutElement[] = [];
  for (const el of elements) {
    if (options.preserveLocked && isLocked(el)) {
      // Keep locked at original position.
      results.push({ id: el.id, position: { ...el.position } });
      obstacles.push({ x: el.position.x, y: el.position.y, w: el.position.w, h: el.position.h });
    } else {
      freeElements.push(el);
    }
  }

  // Initialize free-rect list with the viewport minus obstacles.
  let freeRects: FreeRect[] = [
    { x: 0, y: 0, w: options.viewport.width, h: options.viewport.height },
  ];
  // Carve out obstacles from the initial free space.
  for (const obs of obstacles) {
    freeRects = splitFreeRects(freeRects, obs);
  }

  for (const el of freeElements) {
    const w = el.position.w;
    const h = el.position.h;

    // Find best free-rect: prefer top-most row first (smallest y) so
    // elements fill the current row before wrapping, then BSSF within
    // the same row (best short side fit).
    let bestIdx = -1;
    let bestY = Infinity;
    let bestShortSide = Infinity;
    let bestLongSide = Infinity;
    for (let i = 0; i < freeRects.length; i++) {
      const fr = freeRects[i];
      if (fr.w < w + options.gap || fr.h < h + options.gap) continue;
      const leftoverW = fr.w - w - options.gap;
      const leftoverH = fr.h - h - options.gap;
      const shortSide = Math.min(leftoverW, leftoverH);
      const longSide = Math.max(leftoverW, leftoverH);
      if (fr.y < bestY || (fr.y === bestY && (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)))) {
        bestY = fr.y;
        bestShortSide = shortSide;
        bestLongSide = longSide;
        bestIdx = i;
      }
    }

    let placedRect: PlacedRect;
    if (bestIdx === -1) {
      // No fit in viewport — place at (0,0) as fallback.
      placedRect = { x: 0, y: 0, w, h };
    } else {
      const fr = freeRects[bestIdx];
      placedRect = { x: fr.x, y: fr.y, w, h };
    }

    results.push({
      id: el.id,
      position: { ...el.position, x: placedRect.x, y: placedRect.y, w, h },
    });
    placed.push(placedRect);

    // Split the chosen free-rect and remove it, then add the splits.
    if (bestIdx !== -1) {
      const fr = freeRects[bestIdx];
      freeRects.splice(bestIdx, 1);
      freeRects.push(...splitFreeRect(fr, placedRect, options.gap));
    }

    // Cap free-rect list: discard smallest.
    if (freeRects.length > options.maxFreeRects) {
      freeRects.sort((a, b) => a.w * a.h - b.w * b.h);
      freeRects = freeRects.slice(0, options.maxFreeRects);
    }
  }

  return results;
}

/** Split a single free-rect by a placed rect, returning up to 2 sub-rects (right + bottom). */
function splitFreeRect(fr: FreeRect, placed: PlacedRect, gap: number): FreeRect[] {
  const result: FreeRect[] = [];
  // Right slice.
  const rightW = fr.x + fr.w - (placed.x + placed.w + gap);
  if (rightW > 0) {
    result.push({ x: placed.x + placed.w + gap, y: fr.y, w: rightW, h: fr.h });
  }
  // Bottom slice.
  const bottomH = fr.y + fr.h - (placed.y + placed.h + gap);
  if (bottomH > 0) {
    result.push({ x: fr.x, y: placed.y + placed.h + gap, w: fr.w, h: bottomH });
  }
  return result;
}

/** Split multiple free-rects by a single obstacle. */
function splitFreeRects(freeRects: FreeRect[], obs: PlacedRect): FreeRect[] {
  const result: FreeRect[] = [];
  for (const fr of freeRects) {
    if (!intersects(fr, obs)) {
      result.push(fr);
      continue;
    }
    // Split into up to 4 sub-rects (left, right, top, bottom of the obstacle).
    if (obs.x > fr.x) result.push({ x: fr.x, y: fr.y, w: obs.x - fr.x, h: fr.h });
    if (obs.x + obs.w < fr.x + fr.w) result.push({ x: obs.x + obs.w, y: fr.y, w: fr.x + fr.w - (obs.x + obs.w), h: fr.h });
    if (obs.y > fr.y) result.push({ x: fr.x, y: fr.y, w: fr.w, h: obs.y - fr.y });
    if (obs.y + obs.h < fr.y + fr.h) result.push({ x: fr.x, y: obs.y + obs.h, w: fr.w, h: fr.y + fr.h - (obs.y + obs.h) });
  }
  return result;
}
