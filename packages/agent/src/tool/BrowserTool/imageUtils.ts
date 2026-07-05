/**
 * Image helper for BrowserTool — resize a base64 PNG data URL down to a
 * preview-friendly width so the SSE-payload stays small.
 *
 * Why a separate file: the BrowserTool facade is already long; the
 * jimp dependency is heavy enough that grouping it in its own module
 * keeps `BrowserTool.ts` diffs small and makes future caching (e.g.
 * write resized PNG to disk and stream from there) easier to swap in.
 */

const PREVIEW_MAX_WIDTH = 512;

export interface ResizedScreenshot {
  /** data:image/png;base64,<...> ready for <img src> or SSE metadata. */
  dataUrl: string;
  /** Decoded PNG byte count. */
  bytes: number;
  /** Pixel dimensions of the resized image. */
  width: number;
  height: number;
}

/**
 * Resize a `data:image/png;base64,...` data URL down to ≤ PREVIEW_MAX_WIDTH
 * wide. If the source is already smaller, returns it as-is.
 *
 * Best-effort: any jimp failure (corrupt PNG, OOM, etc.) falls back to the
 * original data URL so the renderer still gets something to display.
 * Better a slow / oversized preview than no preview at all.
 */
export async function resizeScreenshotToPreview(dataUrl: string): Promise<ResizedScreenshot> {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return {
      dataUrl,
      bytes: dataUrlByteSize(dataUrl),
      width: 0,
      height: 0,
    };
  }

  const base64 = match[1];
  const sourceBytes = Math.round((base64.length * 3) / 4);

  try {
    const { Jimp } = await import('jimp');
    const buf = Buffer.from(base64, 'base64');
    const img = await Jimp.read(buf);

    const originalWidth = img.width;
    const originalHeight = img.height;

    if (originalWidth <= PREVIEW_MAX_WIDTH) {
      return {
        dataUrl,
        bytes: sourceBytes,
        width: originalWidth,
        height: originalHeight,
      };
    }

    const ratio = PREVIEW_MAX_WIDTH / originalWidth;
    const newHeight = Math.round(originalHeight * ratio);
    img.resize({ w: PREVIEW_MAX_WIDTH, h: newHeight });

    const resizedBuffer = await img.getBuffer('image/png');
    const resizedBase64 = resizedBuffer.toString('base64');

    return {
      dataUrl: `data:image/png;base64,${resizedBase64}`,
      bytes: resizedBuffer.length,
      width: PREVIEW_MAX_WIDTH,
      height: newHeight,
    };
  } catch (err) {
    console.warn('[BrowserTool.imageUtils] resize failed, falling back to original:', err);
    return {
      dataUrl,
      bytes: sourceBytes,
      width: 0,
      height: 0,
    };
  }
}

function dataUrlByteSize(dataUrl: string): number {
  const [, base64 = ''] = dataUrl.split(',', 2);
  return Math.round((base64.length * 3) / 4);
}