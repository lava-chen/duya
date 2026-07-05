/**
 * Canvas units — single source of truth.
 *
 * The conductor canvas model persists `CanvasPosition.x/y/w/h` in *grid
 * units*, where one unit equals `GRID_PX` device pixels. Until this module
 * landed the constant was redeclared in ~8 files (each with the same value
 * by coincidence), and several call sites silently mixed units — most
 * notably the renderer's `FreeformLayer` setting `left/top` in pixels
 * while computing `width/height` in grid units.
 *
 * Rules of use:
 * - Anywhere outside the renderer / canvas DOM, x/y/w/h stay in grid units.
 * - Pixels appear only at the DOM border (style props / getBoundingClientRect).
 * - `gridUnitsToPx` and `pxToGridUnits` are the only sanctioned conversion.
 */

export const GRID_PX = 80;

export function gridUnitsToPx(units: number | undefined): number {
  if (typeof units !== "number" || !Number.isFinite(units)) return 0;
  return Math.round(units * GRID_PX);
}

export function pxToGridUnits(px: number | undefined): number {
  if (typeof px !== "number" || !Number.isFinite(px)) return 0;
  return px / GRID_PX;
}
