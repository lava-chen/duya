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