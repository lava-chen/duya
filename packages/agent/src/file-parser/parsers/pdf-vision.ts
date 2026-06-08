/**
 * pdf-vision - rasterize PDF pages to PNG via poppler-utils (pdftoppm)
 *
 * Output mirrors Python sidecar:
 *   - DPI 200
 *   - PNG format
 *   - Capped to first N pages (PDF_VISION_MAX_PAGES, default 50)
 *
 * Failures are swallowed: we return an empty array so the caller can
 * fall back to text-only or warn the user. The Python sidecar does the
 * same (prints traceback to stderr, never throws).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDF_VISION_MAX_PAGES } from '../types.js';

const DPI = 200;
// Thumbnail uses a lower DPI than full-page rasterization because
// the output is downscaled to 300px wide — high DPI only inflates
// the buffer without improving the preview.
const THUMBNAIL_DPI = 100;
const THUMBNAIL_MAX_WIDTH = 300;

export async function getPageCount(
  filePath: string,
  pdfinfo: string,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const proc = spawn(pdfinfo, [filePath]);
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = out.match(/^Pages:\s+(\d+)/m);
      resolve(m ? parseInt(m[1], 10) : null);
    });
  });
}

export async function rasterizePages(
  filePath: string,
  pdftoppm: string,
  pageCount: number,
): Promise<Array<{ base64: string; mediaType: 'image/png'; page: number }>> {
  const pageLimit = Math.min(pageCount, PDF_VISION_MAX_PAGES);
  if (pageLimit <= 0) return [];

  const tmpDir = await mkdtemp(join(tmpdir(), 'duya-pdf-'));
  try {
    const prefix = join(tmpDir, 'page');
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-png',
        '-r', String(DPI),
        '-f', '1',
        '-l', String(pageLimit),
        filePath,
        prefix,
      ];
      const proc = spawn(pdftoppm, args);
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
      });
    });

    const entries = (await readdir(tmpDir))
      .filter((f) => f.endsWith('.png'))
      .sort();
    const fs = await import('node:fs/promises');
    const images = await Promise.all(
      entries.map(async (f, i) => {
        const buf = await fs.readFile(join(tmpDir, f));
        return {
          base64: buf.toString('base64'),
          mediaType: 'image/png' as const,
          page: i,
        };
      }),
    );
    return images;
  } catch {
    return [];
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Rasterize only the first page of a PDF and return it as a
 * base64 PNG, suitable for use as an attachment preview thumbnail.
 *
 * Mirrors the Python sidecar's `_render_thumbnail`: 100 DPI,
 * capped at 300px wide, PNG output. Failures (no poppler, empty
 * file, rasterize error) are swallowed and return null so the
 * caller can fall back to a placeholder without surfacing an
 * error to the user.
 */
export async function rasterizeThumbnail(
  filePath: string,
  pdftoppm: string,
): Promise<{ base64: string; mediaType: 'image/png' } | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'duya-pdf-thumb-'));
  try {
    const prefix = join(tmpDir, 'page');
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-png',
        '-r', String(THUMBNAIL_DPI),
        '-f', '1',
        '-l', '1',
        '-singlefile',
        filePath,
        prefix,
      ];
      const proc = spawn(pdftoppm, args);
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
      });
    });

    // pdftoppm with -singlefile writes exactly "page.png" (no page
    // number suffix). readdir still works in case the system pdftoppm
    // is older and doesn't honor -singlefile.
    let entries = (await readdir(tmpDir)).filter((f) => f.endsWith('.png'));
    if (entries.length === 0) return null;
    entries.sort();
    const buf = await readFile(join(tmpDir, entries[0]));
    if (buf.length === 0) return null;

    // Downscale to 300px wide using sharp if available, else jimp.
    // sharp is the sharpest, but we already standardized on jimp to
    // avoid native-binding churn. (Phase 1 decision: jimp everywhere.)
    const { Jimp } = await import('jimp');
    const img = await Jimp.read(buf);
    if (img.width > THUMBNAIL_MAX_WIDTH) {
      const ratio = THUMBNAIL_MAX_WIDTH / img.width;
      const newHeight = Math.round(img.height * ratio);
      img.resize({ w: THUMBNAIL_MAX_WIDTH, h: newHeight });
    }
    const resized = await img.getBuffer('image/png');

    return {
      base64: resized.toString('base64'),
      mediaType: 'image/png',
    };
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
