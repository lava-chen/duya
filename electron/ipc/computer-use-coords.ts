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

interface CaptureSize {
  width: number;
  height: number;
}

const zoomOrigins = new Map<string, ZoomOrigin>();
const captureSizes = new Map<string, CaptureSize>();

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
 * Remember the pixel size of the last full-screen capture thumbnail.
 *
 * `desktopCapturer` is asked for a thumbnail at the display's logical
 * size, but the bitmap it actually returns can be smaller (observed:
 * 1440x810 for a 2048x1152 request on a 1.875-scaled 4K panel). Click
 * mapping therefore needs the *actual* bitmap size, not the requested
 * one — remember it after every successful full capture.
 */
export function rememberCaptureSize(
  sessionId: string | undefined,
  size: CaptureSize,
): void {
  if (size.width > 0 && size.height > 0) {
    captureSizes.set(zoomOriginKey(sessionId), size);
  }
}

/** Last remembered capture thumbnail size, if any. */
export function getRememberedCaptureSize(
  sessionId: string | undefined,
): CaptureSize | undefined {
  return captureSizes.get(zoomOriginKey(sessionId));
}

/** Forget the remembered capture size (display change / tests). */
export function clearCaptureSize(sessionId: string | undefined): void {
  captureSizes.delete(zoomOriginKey(sessionId));
}

/**
 * Map a model-supplied image-space point to the physical screen point
 * nut.js expects: rebase out of the active zoom crop (if any), then
 * scale image → physical. Pure — the caller passes the primary
 * display's scaleFactor plus its physical pixel size.
 *
 * The image→physical ratio is `physical pixels / captured bitmap
 * pixels` when both ends are known. Scaling by scaleFactor alone is
 * only correct when the captured bitmap matches the display's logical
 * size — when desktopCapturer hands back a smaller thumbnail, the
 * scaleFactor path lands every click short of its target (up-left).
 * Ratios <= 0 / non-finite and a missing capture size degrade to the
 * scaleFactor behavior instead of collapsing clicks into the corner.
 */
export function modelPointToScreen(
  point: { x: number; y: number },
  sessionId: string | undefined,
  scaleFactor: number,
  physical?: { width: number; height: number },
): ScreenPoint {
  const key = zoomOriginKey(sessionId);
  const origin = zoomOrigins.get(key);
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const img = captureSizes.get(key);
  let kx = sf;
  let ky = sf;
  if (
    img &&
    physical &&
    Number.isFinite(physical.width) &&
    Number.isFinite(physical.height) &&
    physical.width > 0 &&
    physical.height > 0
  ) {
    const rx = physical.width / img.width;
    const ry = physical.height / img.height;
    if (Number.isFinite(rx) && rx > 0) kx = rx;
    if (Number.isFinite(ry) && ry > 0) ky = ry;
  }
  return {
    x: Math.round((point.x + (origin?.x ?? 0)) * kx),
    y: Math.round((point.y + (origin?.y ?? 0)) * ky),
  };
}
