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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDF_VISION_MAX_PAGES } from '../types.js';

const DPI = 200;

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
