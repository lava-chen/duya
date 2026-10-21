/**
 * Canvas-coordinate math for agent-initiated captures.
 *
 * The agent reasons in canvas GRID units — the exact same coordinates
 * `canvas_create_element` accepts for element positions. These helpers
 * convert between that space and what html2canvas needs (absolute client
 * pixels), and compute the temporary pan/zoom required to bring an
 * arbitrary on-canvas rectangle into the visible viewport.
 *
 * Everything here is pure so the coordinate contract can be unit-tested
 * without a DOM.
 */

import { GRID_PX } from "../domain/canvas/units";

export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mirrors CanvasArea's live pan/zoom snapshot (`canvasTransformState`). */
export interface CanvasTransform {
  panX: number;
  panY: number;
  zoom: number;
}

/**
 * Hard zoom floor used when shrinking the view to frame a large region.
 * Mirrors CanvasArea's MIN_ZOOM so capture never moves the view outside
 * the range a user gesture could reach.
 */
const CAPTURE_MIN_ZOOM = 0.2;

/** Screen padding kept around a fitted region, in viewport px. */
const FIT_PADDING_PX = 24;

/**
 * Convert an agent-supplied region into canvas pixel space.
 *
 * `unit: "grid"` (the default contract for canvas_* tools) multiplies by
 * GRID_PX; `unit: "px"` passes raw canvas pixels through unchanged.
 */
export function regionToCanvasPx(
  region: CaptureRect,
  unit: "grid" | "px" = "grid",
): CaptureRect {
  if (unit === "px") return { ...region };
  return {
    x: region.x * GRID_PX,
    y: region.y * GRID_PX,
    w: region.w * GRID_PX,
    h: region.h * GRID_PX,
  };
}

/**
 * Map a canvas-space rect through a view transform to viewport-relative
 * screen px. The `.canvas-inner` layer uses transformOrigin "0 0" with
 * translate(panX, panY) scale(zoom), so this is a plain affine map.
 */
export function canvasRectToScreen(
  rect: CaptureRect,
  t: CanvasTransform,
): CaptureRect {
  return {
    x: t.panX + t.zoom * rect.x,
    y: t.panY + t.zoom * rect.y,
    w: Math.max(0, t.zoom * rect.w),
    h: Math.max(0, t.zoom * rect.h),
  };
}

/** Inverse of `canvasRectToScreen` for a single point. */
export function screenPointToCanvas(
  sx: number,
  sy: number,
  t: CanvasTransform,
): { x: number; y: number } {
  const zoom = sanitizeZoom(t.zoom);
  return { x: (sx - t.panX) / zoom, y: (sy - t.panY) / zoom };
}

/** True when the screen-space rect sits entirely inside the viewport. */
export function isRectFullyVisible(
  screen: CaptureRect,
  viewportW: number,
  viewportH: number,
): boolean {
  return (
    screen.x >= 0 &&
    screen.y >= 0 &&
    screen.x + screen.w <= viewportW &&
    screen.y + screen.h <= viewportH
  );
}

/**
 * Clip a screen-space rect to the viewport bounds. Returns null when the
 * intersection is empty (nothing visible to capture).
 */
export function clipRectToViewport(
  screen: CaptureRect,
  viewportW: number,
  viewportH: number,
): CaptureRect | null {
  const x = Math.max(0, screen.x);
  const y = Math.max(0, screen.y);
  const right = Math.min(viewportW, screen.x + screen.w);
  const bottom = Math.min(viewportH, screen.y + screen.h);
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Compute a temporary transform that frames `canvasRect` in the viewport:
 *
 * - Zoom only ever shrinks (never magnifies past the current zoom), so a
 *   small off-screen region is brought in by panning alone.
 * - The region center lands on the viewport center with padding around it.
 * - Regions larger than what CAPTURE_MIN_ZOOM can fit overflow the
 *   viewport; callers clip and report the actual captured size.
 */
export function computeFitTransform(
  canvasRect: CaptureRect,
  viewportW: number,
  viewportH: number,
  current: CanvasTransform,
): { transform: CanvasTransform; screenRect: CaptureRect } {
  const cur = sanitizeTransform(current);
  const pad = FIT_PADDING_PX;
  const fitZoomW = (viewportW - pad * 2) / Math.max(canvasRect.w, 1);
  const fitZoomH = (viewportH - pad * 2) / Math.max(canvasRect.h, 1);
  const neededZoom = Math.min(fitZoomW, fitZoomH);

  // Shrink only as much as needed; never magnify past the current zoom.
  const targetZoom =
    neededZoom >= cur.zoom
      ? cur.zoom
      : Math.min(cur.zoom, Math.max(neededZoom, CAPTURE_MIN_ZOOM));

  const centerX = canvasRect.x + canvasRect.w / 2;
  const centerY = canvasRect.y + canvasRect.h / 2;
  const transform: CanvasTransform = {
    panX: viewportW / 2 - targetZoom * centerX,
    panY: viewportH / 2 - targetZoom * centerY,
    zoom: targetZoom,
  };

  return { transform, screenRect: canvasRectToScreen(canvasRect, transform) };
}

function sanitizeZoom(z: number): number {
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function sanitizeTransform(t: CanvasTransform): CanvasTransform {
  return {
    panX: Number.isFinite(t.panX) ? t.panX : 0,
    panY: Number.isFinite(t.panY) ? t.panY : 0,
    zoom: sanitizeZoom(t.zoom),
  };
}
