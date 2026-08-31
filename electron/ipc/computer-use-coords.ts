/**
 * computer-use-coords.ts — Model-image-space → physical-screen mapping.
 *
 * The capture image the model sees is a desktopCapturer thumbnail
 * requested at `screen.getPrimaryDisplay().bounds` — logical DIPs.
 * nut.js mouse calls however operate in physical pixels
 * (bounds × scaleFactor). Model-supplied x/y are image-space, so every
 * click / drag point must be scaled logical → physical before reaching
 * the backend; otherwise the cursor lands up-left of the target by
 * 1/scaleFactor. Measured on a 1.25-scaled display: the model picks
 * image center (1024,576), nut moves the cursor to physical (1024,576)
 * which is logical (819,461) — a consistent 20% offset.
 *
 * After a `zoom` the model's coords are relative to the cropped image,
 * so the crop origin is remembered per session and added back before
 * scaling. A subsequent full `capture` invalidates it (the model is
 * looking at a full-screen image again).
 *
 * Kept electron-free so the mapping is unit-testable without mocking
 * the electron module; the caller supplies the display scaleFactor.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

interface ZoomOrigin {
  x: number;
  y: number;
}

const zoomOrigins = new Map<string, ZoomOrigin>();

export function zoomOriginKey(sessionId: string | undefined): string {
  return sessionId ?? '(no-session)';
}

/** Call after a successful zoom whose crop actually happened. */
export function rememberZoomOrigin(
  sessionId: string | undefined,
  origin: ZoomOrigin,
): void {
  zoomOrigins.set(zoomOriginKey(sessionId), origin);
}

/** Call after a full `capture` — the model is back on full-screen coords. */
export function clearZoomOrigin(sessionId: string | undefined): void {
  zoomOrigins.delete(zoomOriginKey(sessionId));
}

/**
 * Map a model-supplied image-space point to the physical screen point
 * nut.js expects: rebase out of the active zoom crop (if any), then
 * scale logical → physical. Pure — the caller passes the primary
 * display's scaleFactor; values <= 0 fall back to 1 (unscaled) so a
 * missing display readout degrades to the old behavior instead of
 * collapsing every click into the top-left corner.
 */
export function modelPointToScreen(
  point: { x: number; y: number },
  sessionId: string | undefined,
  scaleFactor: number,
): ScreenPoint {
  const origin = zoomOrigins.get(zoomOriginKey(sessionId));
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: Math.round((point.x + (origin?.x ?? 0)) * sf),
    y: Math.round((point.y + (origin?.y ?? 0)) * sf),
  };
}
