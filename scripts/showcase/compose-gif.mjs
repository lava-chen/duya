// scripts/showcase/compose-gif.mjs
// Compose the PNG sequence under assets/showcase/ into a single looping GIF.
// Used by README and external announcement posts.
//
// Implementation notes:
//   - Pure-JS GIF encoder (`gifenc`) keeps this dependency-light; no
//     system ffmpeg / imagemagick required.
//   - Frame order follows scenario id (01 -> 05).
//   - Each PNG is downscaled to 720px wide to keep the GIF under ~5 MB.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SHOWCASE_DIR = path.join(ROOT, 'assets', 'showcase');
const OUT_GIF = path.join(SHOWCASE_DIR, 'demo.gif');
const FRAME_DELAY_MS = 1400;        // 1.4s per frame
const MAX_WIDTH = 720;

/**
 * @param {object} [opts]
 * @param {string[]} [opts.frameIds] Default: ['01-launcher', ... '05-permission-prompt']
 */
export async function composeGif(opts = {}) {
  const ids = opts.frameIds ?? [
    '01-launcher',
    '02-research-browser',
    '03-files-edit',
    '04-canvas-conductor',
    '05-permission-prompt',
  ];

  const frames = [];
  for (const id of ids) {
    const p = path.join(SHOWCASE_DIR, `${id}.png`);
    if (!existsSync(p)) continue;
    frames.push({ id, png: await readFile(p) });
  }
  if (frames.length === 0) {
    console.log('[gif] no frames yet — run `npm run showcase` first.');
    return;
  }

  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  const decoded = await Promise.all(
    frames.map(async (f) => {
      const { PNG } = await loadPngCtor();
      const img = PNG.sync.read(f.png);
      return { id: f.id, img, width: img.width, height: img.height };
    })
  );

  const targetH = Math.round(
    (decoded[0].height * MAX_WIDTH) / decoded[0].width
  );

  const encoder = new GIFEncoder();
  for (const f of decoded) {
    const scaled = scaleNearest(f.img, MAX_WIDTH, targetH);
    const palette = quantize(scaled.data, 256, { format: 'rgb444' });
    const indexed = applyPalette(scaled.data, palette, 'rgb444');
    encoder.writeFrame(indexed, MAX_WIDTH, targetH, {
      palette,
      delay: FRAME_DELAY_MS,
    });
  }
  encoder.finish();
  const bytes = encoder.bytes();
  await writeFile(OUT_GIF, Buffer.from(bytes));
  console.log(`[gif] wrote ${path.relative(ROOT, OUT_GIF)} (${(bytes.length / 1024).toFixed(0)} KB, ${decoded.length} frames)`);
}

/**
 * Lazy-load pngjs from project deps. Falls back to error if not installed.
 */
async function loadPngCtor() {
  try {
    const mod = await import('pngjs');
    return [mod.PNG];
  } catch {
    throw new Error(
      'pngjs is required for compose-gif. Install with: npm i -D pngjs gifenc'
    );
  }
}

/**
 * Nearest-neighbor scale into a new PNG-like object { data, width, height }.
 */
function scaleNearest(srcImg, newW, newH) {
  const out = new Uint8Array(newW * newH * 4);
  const xRatio = srcImg.width / newW;
  const yRatio = srcImg.height / newH;
  for (let y = 0; y < newH; y++) {
    const sy = Math.floor(y * yRatio);
    for (let x = 0; x < newW; x++) {
      const sx = Math.floor(x * xRatio);
      const si = (sy * srcImg.width + sx) * 4;
      const di = (y * newW + x) * 4;
      out[di] = srcImg.data[si];
      out[di + 1] = srcImg.data[si + 1];
      out[di + 2] = srcImg.data[si + 2];
      out[di + 3] = srcImg.data[si + 3];
    }
  }
  return { data: out, width: newW, height: newH };
}

// CLI entry: `node scripts/showcase/compose-gif.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  composeGif().catch((e) => {
    console.error('[gif] fatal:', e.message);
    process.exit(1);
  });
}