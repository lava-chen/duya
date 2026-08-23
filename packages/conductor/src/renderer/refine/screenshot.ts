/**
 * Widget DOM screenshot for the iterative refinement loop.
 *
 * Lazy-loads `html2canvas` so the ~45 KB dep stays out of the main bundle
 * until the user actually opens a refine session.
 *
 * Returns a PNG data URL (base64) matching the element's on-screen size,
 * scaled by devicePixelRatio for retina fidelity.
 */

import { canvasTransformState } from "../domain/canvas/transform-state";
import {
  canvasRectToScreen,
  clipRectToViewport,
  computeFitTransform,
  isRectFullyVisible,
  regionToCanvasPx,
  screenPointToCanvas,
  type CaptureRect,
  type CanvasTransform,
} from "./region-fit";

export interface CapturedScreenshot {
  pngBase64: string;
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * html2canvas currently cannot parse CSS Color 4's `color()` syntax, even
 * though Chromium can render it. Chromium may expose theme tokens in that
 * form through getComputedStyle(), so normalize numeric color-space channels
 * to the broadly supported rgb()/rgba() syntax before html2canvas reads the
 * clone.
 *
 * This intentionally leaves unknown color spaces alone. Replacing an unknown
 * color with a guessed value is worse than retaining the browser's original
 * declaration, and current DUYA themes emit numeric channels handled here.
 */
export function normalizeHtml2CanvasColor(value: string): string | null {
  const match = value.trim().match(/^color\(\s*[a-z0-9-]+\s+(.+?)\s*\)$/i);
  if (!match) return null;

  const [rawChannels, rawAlpha] = match[1].split("/").map((part) => part.trim());
  const channels = rawChannels.split(/\s+/).map(parseColorChannel);
  const alpha = rawAlpha === undefined ? 1 : parseColorChannel(rawAlpha);
  if (channels.length !== 3 || channels.some((channel) => channel === null) || alpha === null) {
    return null;
  }

  const [red, green, blue] = channels as number[];
  const opacity = alpha as number;
  const rgb = [red, green, blue].map((channel) => Math.round(channel * 255));
  return opacity >= 1
    ? `rgb(${rgb.join(", ")})`
    : `rgba(${rgb.join(", ")}, ${roundOpacity(opacity)})`;
}

/** Replace every supported CSS Color 4 function inside a CSS declaration. */
export function normalizeHtml2CanvasColors(value: string): string {
  return value.replace(/color\(\s*[a-z0-9-]+\s+[^()]+?\s*\)/gi, (color) =>
    normalizeHtml2CanvasColor(color) ?? color,
  );
}

function parseColorChannel(value: string): number | null {
  const parsed = value.endsWith("%")
    ? Number.parseFloat(value) / 100
    : Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : null;
}

function roundOpacity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * html2canvas renders a cloned document. Copy only computed declarations that
 * contain `color()` to inline, normalized values in that clone; the live
 * canvas and its theme variables are never mutated.
 */
export function normalizeHtml2CanvasClone(clonedDocument: Document): void {
  const view = clonedDocument.defaultView;
  if (!view) return;

  for (const element of clonedDocument.querySelectorAll<HTMLElement>("*")) {
    const computed = view.getComputedStyle(element);
    for (const property of computed) {
      const value = computed.getPropertyValue(property);
      if (!value.includes("color(")) continue;
      const normalized = normalizeHtml2CanvasColors(value);
      if (normalized !== value) {
        element.style.setProperty(property, normalized, "important");
      }
    }
  }
}

export async function captureWidgetEl(
  el: HTMLElement,
): Promise<CapturedScreenshot> {
  const rect = el.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);

  const html2canvas = (await import("html2canvas")).default;
  const canvas = await html2canvas(el, {
    backgroundColor: null,
    scale: pixelRatio,
    useCORS: true,
    logging: false,
    width: rect.width,
    height: rect.height,
    windowWidth: rect.width,
    windowHeight: rect.height,
    onclone: normalizeHtml2CanvasClone,
  });

  const pngBase64 = canvas.toDataURL("image/png").replace(
    /^data:image\/png;base64,/,
    "",
  );

  return {
    pngBase64,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    pixelRatio,
  };
}

// ── Canvas-level capture for agent visual analysis ──────────────────

/**
 * Scope of canvas capture.
 * - `viewport`: capture what the user currently sees (visible canvas area)
 * - `element`: capture a single element by its DOM selector
 * - `region`: capture a rectangle given in CANVAS coordinates — grid units
 *   by default, the same coordinate space agents use when placing elements
 */
export type CaptureScope = "viewport" | "element" | "region";

export interface CanvasCaptureOptions {
  scope: CaptureScope;
  /** When scope is 'element', the element ID to capture. */
  elementId?: string;
  /**
   * When scope is 'region', the rectangle in canvas coordinates — grid
   * units by default (`unit: 'grid'`, identical to the position values of
   * canvas_create_element) or raw canvas pixels (`unit: 'px'`). The view
   * does NOT need to show this area: the renderer temporarily pans/zooms
   * to frame it, captures, then restores the previous view.
   */
  region?: { x: number; y: number; w: number; h: number; unit?: "grid" | "px" };
}

export interface CanvasCaptureResult extends CapturedScreenshot {
  scope: CaptureScope;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Data URL ready for <img> src or LLM image content block. */
  dataUrl: string;
}

/** A framed, viewport-clipped crop ready to hand to html2canvas. */
interface CropPlan {
  /** Viewport-relative crop rect (already clipped to the viewport). */
  screen: CaptureRect;
  /**
   * Restores the live view transform after the render, when the plan had
   * to move it. No-op for crops that did not reframe anything.
   */
  restore: () => Promise<void>;
}

/**
 * Captures are serialized: each one may temporarily move the live view
 * transform, so overlapping requests would photograph each other's
 * intermediate framing.
 */
let captureQueue: Promise<unknown> = Promise.resolve();

export function captureCanvasView(
  viewportEl: HTMLElement,
  canvasInnerEl: HTMLElement | null,
  options: CanvasCaptureOptions,
): Promise<CanvasCaptureResult> {
  const run = captureQueue.then(() =>
    captureCanvasViewInner(viewportEl, canvasInnerEl, options),
  );
  // Keep the queue alive on failure so later requests still run — and
  // still see a fully restored view.
  captureQueue = run.catch(() => undefined);
  return run;
}

async function captureCanvasViewInner(
  viewportEl: HTMLElement,
  canvasInnerEl: HTMLElement | null,
  options: CanvasCaptureOptions,
): Promise<CanvasCaptureResult> {
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  // Cap scale to keep capture fast and file sizes reasonable for LLM vision.
  const scale = Math.min(pixelRatio, 1.5);
  const html2canvas = (await import("html2canvas")).default;

  const viewportRect = viewportEl.getBoundingClientRect();
  const viewportW = Math.max(0, Math.floor(viewportRect.width));
  const viewportH = Math.max(0, Math.floor(viewportRect.height));

  let plan: CropPlan;

  if (options.scope === "element") {
    if (!canvasInnerEl || !options.elementId) {
      throw new Error("element scope requires elementId and canvasInnerEl");
    }
    // Native elements use data-native-element-id, widgets use data-testid="widget-shell-<id>"
    const escaped = CSS.escape(options.elementId);
    const el =
      canvasInnerEl.querySelector<HTMLElement>(
        `[data-native-element-id="${escaped}"]`,
      ) ||
      canvasInnerEl.querySelector<HTMLElement>(
        `[data-testid="widget-shell-${escaped}"]`,
      );
    if (!el) {
      throw new Error(`Element not found: ${options.elementId}`);
    }
    // Map the element's current on-screen rect back into canvas space so
    // off-screen elements go through the same frame-and-capture path as
    // explicit regions.
    const t = readTransform();
    const rect = el.getBoundingClientRect();
    const topLeft = screenPointToCanvas(
      rect.left - viewportRect.left,
      rect.top - viewportRect.top,
      t,
    );
    const canvasRect: CaptureRect = {
      x: topLeft.x,
      y: topLeft.y,
      w: rect.width / t.zoom,
      h: rect.height / t.zoom,
    };
    plan = await frameOnScreen(canvasRect, canvasInnerEl, viewportW, viewportH);
  } else if (options.scope === "region") {
    const requested = options.region;
    if (!requested) {
      throw new Error("region scope requires region option");
    }
    if (
      !Number.isFinite(requested.x) ||
      !Number.isFinite(requested.y) ||
      !Number.isFinite(requested.w) ||
      !Number.isFinite(requested.h)
    ) {
      throw new Error(
        `region scope received non-finite coords: ${JSON.stringify(requested)}`,
      );
    }
    if (requested.w <= 0 || requested.h <= 0) {
      throw new Error(
        `region scope requires positive w/h, got ${requested.w}x${requested.h}`,
      );
    }
    const unit = requested.unit ?? "grid";
    const canvasRect = regionToCanvasPx(requested, unit);
    plan = await frameOnScreen(canvasRect, canvasInnerEl, viewportW, viewportH);
  } else {
    // viewport — no reframing needed; capture the visible area as-is.
    plan = {
      screen: { x: 0, y: 0, w: viewportW, h: viewportH },
      restore: async () => {},
    };
  }

  try {
    // Downsample very large captures so html2canvas stays fast and the
    // resulting PNG stays small enough to save and send to vision models.
    // html2canvas output size is (width * scale), so cap that product.
    const MAX_CAPTURE_WIDTH = 1920;
    const renderScale =
      plan.screen.w * scale > MAX_CAPTURE_WIDTH
        ? MAX_CAPTURE_WIDTH / plan.screen.w
        : scale;

    const canvas = await html2canvas(viewportEl, {
      backgroundColor: null,
      scale: renderScale,
      useCORS: true,
      logging: false,
      width: Math.max(1, Math.floor(plan.screen.w)),
      height: Math.max(1, Math.floor(plan.screen.h)),
      // html2canvas crops in ABSOLUTE client coordinates (its renderer
      // translates by (-x, -y); defaults come from getBoundingClientRect).
      // Passing viewport-relative offsets here was an offset bug whenever
      // .canvas-area sat away from the client origin.
      x: viewportRect.left + plan.screen.x,
      y: viewportRect.top + plan.screen.y,
      // Keep the clone's layout identical to the real window; sizing it to
      // the crop used to reflow percentage-based layouts before painting.
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      // Ignore UI overlays (zoom pill, style panels, toolbars) that are
      // rendered inside the viewport but should not appear in agent screenshots.
      // These elements are marked with `data-capture-ignore` in CanvasArea.
      ignoreElements: (el: Element) =>
        el instanceof HTMLElement && el.dataset.captureIgnore === "",
      onclone: normalizeHtml2CanvasClone,
    });

    const dataUrl = canvas.toDataURL("image/png");
    const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

    return {
      pngBase64,
      width: canvas.width,
      height: canvas.height,
      pixelRatio,
      scope: options.scope,
      capturedAt: new Date().toISOString(),
      dataUrl,
    };
  } finally {
    await plan.restore();
  }
}

/**
 * Turn a canvas-space rectangle into a concrete crop plan:
 *
 * 1. If the rect is not fully visible under the current view transform,
 *    temporarily apply a fit transform to `.canvas-inner` (pan/zoom only
 *    shrinks; never magnifies past the user's current zoom) and wait for
 *    paint. `plan.restore()` puts the previous transform back.
 * 2. Clip the on-screen projection to the viewport bounds. A rect too
 *    large for the zoom floor yields the largest visible intersection —
 *    callers report actual size via the returned width/height.
 */
async function frameOnScreen(
  canvasRect: CaptureRect,
  canvasInnerEl: HTMLElement | null,
  viewportW: number,
  viewportH: number,
): Promise<CropPlan> {
  const t = readTransform();
  let screen = canvasRectToScreen(canvasRect, t);

  if (!isRectFullyVisible(screen, viewportW, viewportH)) {
    if (!canvasInnerEl) {
      throw new Error(
        "Canvas content layer (.canvas-inner) is not mounted; cannot frame the requested canvas area.",
      );
    }
    const fit = computeFitTransform(canvasRect, viewportW, viewportH, t);
    const previousTransform = canvasInnerEl.style.transform;
    canvasInnerEl.style.transform =
      `translate(${fit.transform.panX}px, ${fit.transform.panY}px) ` +
      `scale(${fit.transform.zoom})`;
    await waitForPaint(2);
    screen = fit.screenRect;
    return {
      screen,
      restore: async () => {
        canvasInnerEl.style.transform = previousTransform;
        await waitForPaint(1);
      },
    };
  }

  const clipped = clipRectToViewport(screen, viewportW, viewportH);
  if (!clipped) {
    throw new Error(
      `Requested canvas rect (${canvasRect.x}, ${canvasRect.y}, ` +
        `${canvasRect.w}, ${canvasRect.h}) has no on-screen intersection.`,
    );
  }
  return { screen: clipped, restore: async () => {} };
}

function readTransform(): CanvasTransform {
  return {
    panX: canvasTransformState.panX,
    panY: canvasTransformState.panY,
    zoom: canvasTransformState.zoom,
  };
}

/**
 * Yield to the browser for `frames` animation frames so React commit and
 * paint actually finish before html2canvas walks the transformed DOM.
 * Falls back to timeouts in environments without rAF (jsdom tests).
 */
async function waitForPaint(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 16);
      }
    });
  }
}
