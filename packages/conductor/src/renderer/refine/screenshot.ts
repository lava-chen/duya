/**
 * Widget DOM screenshot for the iterative refinement loop.
 *
 * Lazy-loads `html2canvas` so the ~45 KB dep stays out of the main bundle
 * until the user actually opens a refine session.
 *
 * Returns a PNG data URL (base64) matching the element's on-screen size,
 * scaled by devicePixelRatio for retina fidelity.
 */

export interface CapturedScreenshot {
  pngBase64: string;
  width: number;
  height: number;
  pixelRatio: number;
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
 * - `region`: capture a rectangular region of the canvas (canvas coords)
 */
export type CaptureScope = "viewport" | "element" | "region";

export interface CanvasCaptureOptions {
  scope: CaptureScope;
  /** When scope is 'element', the element ID to capture. */
  elementId?: string;
  /** When scope is 'region', the region in screen pixels relative to the viewport. */
  region?: { x: number; y: number; w: number; h: number };
}

export interface CanvasCaptureResult extends CapturedScreenshot {
  scope: CaptureScope;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Data URL ready for <img> src or LLM image content block. */
  dataUrl: string;
}

/**
 * Capture a screenshot of the canvas at three granularities.
 *
 * - `viewport`: captures the visible canvas viewport element. The caller
 *   passes the viewport container (the scrollable div that wraps the
 *   canvas inner content).
 * - `element`: captures a single element by its DOM ID. The caller
 *   passes the canvas inner container; we query `[data-element-id]`
 *   within it.
 * - `region`: captures a sub-rectangle of the viewport. Coordinates are
 *   in screen pixels relative to the viewport's top-left corner.
 *
 * The returned `dataUrl` is a `data:image/png;base64,...` string that
 * can be used directly in an `<img>` tag or sent to a multimodal LLM
 * as an image content block.
 */
export async function captureCanvasView(
  viewportEl: HTMLElement,
  canvasInnerEl: HTMLElement | null,
  options: CanvasCaptureOptions,
): Promise<CanvasCaptureResult> {
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  // Cap scale to keep capture fast and file sizes reasonable for LLM vision.
  const scale = Math.min(pixelRatio, 1.5);
  const html2canvas = (await import("html2canvas")).default;

  let targetEl: HTMLElement;
  let captureX = 0;
  let captureY = 0;
  let captureW = 0;
  let captureH = 0;

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
    targetEl = el;
    const rect = el.getBoundingClientRect();
    captureW = rect.width;
    captureH = rect.height;
  } else if (options.scope === "region") {
    if (!options.region) {
      throw new Error("region scope requires region option");
    }
    targetEl = viewportEl;
    captureX = options.region.x;
    captureY = options.region.y;
    captureW = options.region.w;
    captureH = options.region.h;
  } else {
    // viewport
    targetEl = viewportEl;
    const rect = viewportEl.getBoundingClientRect();
    captureW = rect.width;
    captureH = rect.height;
  }

  // Downsample very large captures so html2canvas stays fast and the
  // resulting PNG stays small enough to save and send to vision models.
  // html2canvas output size is (width * scale), so cap that product.
  const MAX_CAPTURE_WIDTH = 1920;
  const renderScale =
    captureW * scale > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / captureW : scale;

  const canvas = await html2canvas(targetEl, {
    backgroundColor: null,
    scale: renderScale,
    useCORS: true,
    logging: false,
    width: captureW,
    height: captureH,
    x: captureX,
    y: captureY,
    windowWidth: captureW,
    windowHeight: captureH,
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
}
