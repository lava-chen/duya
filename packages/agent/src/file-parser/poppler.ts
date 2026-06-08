/**
 * poppler - detect poppler-utils binaries on the host
 *
 * Needed only for PDF vision fallback (rasterize scanned PDFs to PNGs).
 * If poppler is not installed, PdfVisionParser returns no images and the
 * caller falls back to text-only or "low confidence" warnings.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PopplerInfo {
  /** Path to `pdftoppm` (rasterizer) or null if not found */
  pdftoppm: string | null;
  /** Path to `pdfinfo` (metadata) or null if not found */
  pdfinfo: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;

let cached: PopplerInfo | null = null;

async function probe(candidate: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn(candidate, ['-v'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // pdftoppm and pdfinfo both print to stderr on -v; exit 0 is success
      resolve(code === 0);
    });
  });
}

/**
 * Try a list of candidate executable names (without extension first, then
 * Windows-suffixed variants). Returns the first one that responds.
 */
async function findExecutable(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await probe(c)) return c;
  }
  return null;
}

/**
 * Detect poppler-utils on the host. Cached after first call.
 * On Windows looks in common install locations; on macOS uses /usr/bin/...
 * via PATH probe.
 */
export async function detectPoppler(): Promise<PopplerInfo> {
  if (cached) return cached;

  const winCandidates = process.platform === 'win32'
    ? ['pdftoppm', 'pdfinfo', 'pdftoppm.exe', 'pdfinfo.exe']
    : ['pdftoppm', 'pdfinfo'];

  // First check standard PATH probe
  const [pdftoppm, pdfinfo] = await Promise.all([
    findExecutable(winCandidates),
    findExecutable(winCandidates.map((c) => c.replace(/^pdftoppm/, 'pdfinfo'))),
  ]);

  // Honor DUYA_POPPLER_PATH env var (matches Python sidecar)
  const envBase = process.env.DUYA_POPPLER_PATH;
  if (envBase && existsSync(envBase)) {
    const winBin = join(envBase, 'bin');
    const macBin = join(envBase, 'Library', 'bin');
    for (const base of [envBase, winBin, macBin]) {
      if (!existsSync(base)) continue;
      const ppExt = process.platform === 'win32' ? '.exe' : '';
      const ppPath = join(base, `pdftoppm${ppExt}`);
      const piPath = join(base, `pdfinfo${ppExt}`);
      if (!pdftoppm && existsSync(ppPath)) {
        // best-effort: trust the path without exec probe
        cached = { pdftoppm: ppPath, pdfinfo: existsSync(piPath) ? piPath : null };
        return cached;
      }
    }
  }

  cached = { pdftoppm, pdfinfo };
  return cached;
}

/** Test helper: reset the cache between tests. */
export function _resetPopplerCache(): void {
  cached = null;
}
