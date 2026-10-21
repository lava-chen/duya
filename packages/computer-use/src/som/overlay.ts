/**
 * overlay.ts — SOM (Set-of-Mark) overlay renderer (plan 454 §5 Task D).
 *
 * Draws numbered red boxes on top of a captured screen so the LLM
 * can refer to UI elements by index rather than guessing pixel
 * coordinates. Inspired by the Set-of-Mark prompting paper + the
 * claude-quickstarts computer-use-demo.
 *
 * Phase 1 ships a simple sharp-based SVG composite:
 *   - Each element bbox gets a 2px red border + a 24px square in the
 *     top-left corner with the index number drawn in white.
 *   - A small red cross marks the bbox center for hit-targeting.
 *
 * Performance budget: <100ms per render (sharp async + small overlay).
 * The function returns the composited PNG buffer ready for base64
 * encoding.
 */

import type { SharpAdapter, SharpPipeline } from '../backend/electron/win32.js';
import type { SomElement } from '../backend/types.js';

/**
 * Options for the overlay renderer.
 *
 * - `borderWidth`: rectangle border thickness in px (default 2).
 * - `markerSize`: corner index marker side length in px (default 24).
 * - `showCenterCross`: whether to draw the red cross at bbox centers.
 * - `crossSize`: cross arm length in px (default 8).
 */
export interface DrawSomOverlayOptions {
  borderWidth?: number;
  markerSize?: number;
  showCenterCross?: boolean;
  crossSize?: number;
}

const DEFAULT_OPTIONS: Required<DrawSomOverlayOptions> = {
  borderWidth: 2,
  markerSize: 24,
  showCenterCross: true,
  crossSize: 8,
};

/**
 * Build the SVG markup used as the overlay layer. Kept as a separate
 * pure function so it can be tested without an image pipeline.
 *
 * The SVG is rendered at the natural image size. sharp composites it
 * at (0, 0) with no scaling.
 */
export function buildSomOverlaySvg(
  width: number,
  height: number,
  elements: readonly SomElement[],
  opts: DrawSomOverlayOptions = {},
): string {
  const cfg = { ...DEFAULT_OPTIONS, ...opts };
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
  );
  parts.push(`<style>
      .cu-bbox { fill: none; stroke: #ff3b30; stroke-width: ${cfg.borderWidth}; }
      .cu-marker { fill: #ff3b30; }
      .cu-marker-text { fill: #ffffff; font-family: Arial, sans-serif; font-size: 14px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
      .cu-cross { stroke: #ff3b30; stroke-width: 2; }
    </style>`);

  for (const el of elements) {
    const { x, y, w, h } = el.bbox;
    const cx = x + w / 2;
    const cy = y + h / 2;

    parts.push(
      `<rect class="cu-bbox" x="${x}" y="${y}" width="${w}" height="${h}" />`,
    );

    // Top-left corner marker (filled red square with white number).
    parts.push(
      `<rect class="cu-marker" x="${x}" y="${y}" width="${cfg.markerSize}" height="${cfg.markerSize}" />`,
    );
    parts.push(
      `<text class="cu-marker-text" x="${x + cfg.markerSize / 2}" y="${y + cfg.markerSize / 2}">${el.index}</text>`,
    );

    // Center cross (helps the model target the exact center).
    if (cfg.showCenterCross) {
      const s = cfg.crossSize;
      parts.push(
        `<line class="cu-cross" x1="${cx - s}" y1="${cy}" x2="${cx + s}" y2="${cy}" />`,
      );
      parts.push(
        `<line class="cu-cross" x1="${cx}" y1="${cy - s}" x2="${cx}" y2="${cy + s}" />`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Render a SOM overlay onto the given image and return the composited
 * PNG buffer.
 *
 * Implementation notes:
 *   - sharp is async; we await each step so the consumer sees the
 *     final buffer before encoding to base64.
 *   - When `elements` is empty, the original buffer is returned
 *     unchanged — short-circuit avoids a sharp round trip.
 */
export async function drawSomOverlay(
  sharp: SharpAdapter,
  image: Buffer,
  elements: readonly SomElement[],
  opts: DrawSomOverlayOptions = {},
  dims?: { width: number; height: number },
): Promise<Buffer> {
  if (elements.length === 0) return image;

  // sharp's composite() rejects an overlay larger than the base image
  // ("Image to composite must have same dimensions or smaller"), so the
  // SVG must be sized to the *actual* capture — a hardcoded 1920x1080
  // overlay explodes on smaller thumbnails (observed live: desktopCapturer
  // returned 1440x810 for a 2048x1152 request on a 1.875-scaled 4K
  // panel). Resolution order: explicit dims from the caller (win32
  // capture knows the thumbnail size) → sharp metadata probe → legacy
  // 1920x1080 fallback.
  let svgWidth = dims?.width ?? 0;
  let svgHeight = dims?.height ?? 0;
  if (!svgWidth || !svgHeight) {
    try {
      const meta = await sharp(image).metadata?.();
      svgWidth = svgWidth || meta?.width || 1920;
      svgHeight = svgHeight || meta?.height || 1080;
    } catch {
      svgWidth = svgWidth || 1920;
      svgHeight = svgHeight || 1080;
    }
  }
  const svg = buildSomOverlaySvg(svgWidth, svgHeight, elements, opts);

  // Render the SVG to a PNG buffer via sharp(SVG-as-buffer).
  const overlayPng = await sharp(Buffer.from(svg, 'utf-8'))
    .png({ compressionLevel: 9 })
    // toBuffer is on the encoded pipeline.
    .toBuffer();

  // Composite the overlay on top of the original image.
  const composited: Buffer = await sharp(image)
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer();

  return composited;
}

/**
 * Convenience: same as `drawSomOverlay` but accepts a raw image
 * pipeline (for callers that already have a sharp pipeline open).
 * Useful when the caller wants to chain resize → composite → encode
 * in a single pipeline (avoids the intermediate PNG encode).
 */
export async function drawSomOverlayOnto(
  pipeline: SharpPipeline,
  overlayPng: Buffer,
): Promise<Buffer> {
  const final = pipeline
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .png({ compressionLevel: 6 });
  return final.toBuffer();
}