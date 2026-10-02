/**
 * Find a fully-empty rectangle on the canvas.
 *
 * Unlike {@link binPack}, which greedily fills the first free-rect that
 * fits a row anchor and can place an element so it overlaps an obstacle
 * that lives further along the X axis, this algorithm explicitly
 * verifies that **every point** of the candidate rectangle is outside
 * every obstacle. Among all legal candidates it picks the one closest
 * to canvas center.
 *
 * The previous `viewportAwarePack`-based implementation silently placed
 * elements on top of nearby obstacles whenever the chosen low-`y`
 * free-rect was a thin horizontal sliver. See plan 239 for the bug
 * context.
 *
 * Pure function. Coordinates: grid units (1 unit = 80 px).
 */
export interface FindEmptySpaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FindEmptySpaceOptions {
  /** Canvas bounds in grid units. */
  viewport: { width: number; height: number };
  /** Grid units of padding applied around each obstacle. Default 0.25. */
  gap?: number;
  /**
   * Sweep step in grid units. Smaller step = denser sweep = better fit
   * but slower. Default adapts to obstacle count: 1.0 below 30
   * obstacles, 0.5 at or above. Override to force a specific resolution.
   */
  step?: number;
}

export interface FindEmptySpaceResult {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Squared distance from the chosen rectangle's center to the canvas
   * center. Exposed so callers (and the agent) can tell why this spot
   * was picked and roughly how tight the fit is.
   */
  score: number;
}

/**
 * Find a `w × h` rectangle that does not intersect any obstacle, picking
 * the candidate closest to canvas center. Returns `null` when no fully
 * empty placement fits inside the viewport at the requested size.
 *
 * Connectors (`native/connector` etc.) should already be filtered out by
 * the caller — this function treats every entry in `obstacles` as a
 * solid rectangle and does not special-case zero-area geometry.
 */
export function findEmptySpace(
  obstacles: ReadonlyArray<FindEmptySpaceRect>,
  size: { w: number; h: number },
  options: FindEmptySpaceOptions,
): FindEmptySpaceResult | null {
  const gap = options.gap ?? 0.25;
  const viewport = options.viewport;
  const w = size.w;
  const h = size.h;

  // Reject impossible inputs early.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;
  if (w > viewport.width || h > viewport.height) return null;

  // Inflate each obstacle by `gap` on every side so the new rectangle
  // keeps the requested breathing room from neighbours.
  const padded = obstacles
    .filter((obs) => Number.isFinite(obs.w) && Number.isFinite(obs.h) && obs.w > 0 && obs.h > 0)
    .map((obs) => ({
      x: obs.x - gap,
      y: obs.y - gap,
      w: obs.w + gap * 2,
      h: obs.h + gap * 2,
    }));

  // Sweep step: 0.5 grid units keeps the candidate grid fine enough to
  // land exactly on canvas center (20, 15) for an odd-dim rectangle
  // (e.g. 4x3 → top-left (18, 13.5)). At a viewport of 40x30 that's
  // at most ~4700 candidates; per-candidate cost is O(obstacles) AABB
  // checks, which is cheap (<1ms in practice for hundreds of obstacles).
  const step = options.step ?? 0.5;
  const safeStep = step > 0 ? step : 0.5;

  // Candidate sweep range. The candidate's top-left can move until the
  // right/bottom edge sits exactly on the viewport edge.
  const maxX = viewport.width - w;
  const maxY = viewport.height - h;
  if (maxX < 0 || maxY < 0) return null;

  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  let best: FindEmptySpaceResult | null = null;

  // Floating-point bounds — snap slightly past the max so the last
  // candidate that fits inside the viewport is still visited.
  for (let y = 0; y <= maxY + 1e-9; y += safeStep) {
    // Clamp the loop variable so accumulation doesn't drift past `maxY`.
    const cy = y > maxY ? maxY : y;
    for (let x = 0; x <= maxX + 1e-9; x += safeStep) {
      const cx = x > maxX ? maxX : x;

      if (!isRectangleFree(cx, cy, w, h, padded)) continue;

      const candidateCenterX = cx + w / 2;
      const candidateCenterY = cy + h / 2;
      const dx = candidateCenterX - centerX;
      const dy = candidateCenterY - centerY;
      const score = dx * dx + dy * dy;

      if (best === null || score < best.score) {
        best = { x: cx, y: cy, w, h, score };
      }
    }
  }

  return best;
}

/**
 * Strict AABB "fully outside" test. Returns true when the rectangle at
 * (x, y, w, h) shares zero area with any obstacle in the list. Uses
 * strict inequalities so rectangles that merely touch along an edge are
 * still considered free.
 */
function isRectangleFree(
  x: number,
  y: number,
  w: number,
  h: number,
  obstacles: ReadonlyArray<FindEmptySpaceRect>,
): boolean {
  for (const obs of obstacles) {
    // Touching on an edge is OK (no overlap). True overlap requires
    // every axis to have a positive-length intersection.
    if (x < obs.x + obs.w && x + w > obs.x && y < obs.y + obs.h && y + h > obs.y) {
      return false;
    }
  }
  return true;
}
