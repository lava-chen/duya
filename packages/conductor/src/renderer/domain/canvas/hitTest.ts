/**
 * Geometric hit-test with fuzzy padding.
 *
 * Replaces DOM `closest()` for element-body hit-test. The fuzzy
 * padding makes the hit zone extend beyond element borders so that
 * small gaps between elements do not block clicks.
 *
 * Coordinates: grid units.
 */
import type { CanvasSpatialIndex } from './spatialIndex';

export interface HitTestOptions {
  /** Grid-unit padding around the point that still counts as a hit. */
  fuzzyPadding: number;
  /** Element IDs to skip (e.g. the dragged element itself). */
  excludeIds?: Set<string>;
}

export function hitTest(
  point: { x: number; y: number },
  index: CanvasSpatialIndex,
  options: HitTestOptions,
): string | null {
  const hit = index.hitTest(point, options.fuzzyPadding);
  if (!hit) return null;
  if (options.excludeIds?.has(hit.id)) return null;
  return hit.id;
}
