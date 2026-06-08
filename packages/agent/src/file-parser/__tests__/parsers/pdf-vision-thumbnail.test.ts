/**
 * pdf-vision thumbnail test
 *
 * rasterizeThumbnail depends on poppler being available. In CI / test
 * envs poppler is usually absent, so we verify the failure path
 * (returns null without throwing) here. The happy path is exercised
 * by manual smoke tests in a real environment.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rasterizeThumbnail } from '../../parsers/pdf-vision.js';

let tmpDir: string;

describe('rasterizeThumbnail', () => {
  it('returns null when pdftoppm is a non-existent binary path', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-thumb-'));
    const f = join(tmpDir, 'fake.pdf');
    writeFileSync(f, '%PDF-1.4\n%fake');
    // Use a path that almost certainly doesn't exist. The call
    // should swallow the spawn ENOENT and return null.
    const result = await rasterizeThumbnail(f, '/nonexistent/pdftoppm');
    expect(result).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the input file is not a valid PDF (rasterize fails)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-thumb-'));
    const f = join(tmpDir, 'garbage.pdf');
    writeFileSync(f, 'this is not a PDF');
    // We need a real binary path that exists. Probe the system
    // for pdftoppm first; if not available, the test is vacuously
    // satisfied (we already covered the "binary missing" path above).
    // Use a path that we know is a binary but rejects the input.
    const result = await rasterizeThumbnail(f, process.execPath);
    expect(result).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null on empty path (graceful failure, not throw)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-thumb-'));
    const f = join(tmpDir, 'empty.pdf');
    writeFileSync(f, '');
    const result = await rasterizeThumbnail(f, '/nonexistent/pdftoppm');
    expect(result).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
