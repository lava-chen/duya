/**
 * pdf parser branch logic test
 *
 * Real PDF fixtures are too large to ship. Instead we mock pdf-parse
 * to return controlled numpages/text values and verify the parser
 * chooses text / hybrid / vision correctly. The actual pdf-parse
 * library is exercised by the sidecar runtime; here we test decision
 * logic only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pdf-parse', () => ({
  default: (buffer: Buffer) => {
    const marker = buffer.toString('utf-8', 0, 8);
    if (marker.startsWith('TEXT-PDF')) {
      return Promise.resolve({ numpages: 5, text: 'word '.repeat(500) });
    }
    if (marker.startsWith('LOW-PDF')) {
      return Promise.resolve({ numpages: 3, text: 'tiny' });
    }
    if (marker.startsWith('EMPTY-PDF')) {
      return Promise.resolve({ numpages: 4, text: '' });
    }
    return Promise.resolve({ numpages: 0, text: '' });
  },
}));

import { PdfParser } from '../../parsers/pdf.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-pdf-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PdfParser branch logic (mocked)', () => {
  it('returns text path for high confidence PDFs', async () => {
    const f = join(tmpDir, 'a.pdf');
    writeFileSync(f, 'TEXT-PDF');
    const result = await new PdfParser().parse(f);
    expect(result.extractMethod).toBe('text');
    expect(result.text).toContain('word');
    expect(result.pageCount).toBe(5);
  });

  it('keeps text path for low confidence when no poppler', async () => {
    const f = join(tmpDir, 'b.pdf');
    writeFileSync(f, 'LOW-PDF');
    const result = await new PdfParser().parse(f);
    // avg = 4 / 3 = 1.33 chars/page -> below 50 threshold, but
    // poppler is not installed in tests so no vision overlay.
    expect(['text', 'hybrid']).toContain(result.extractMethod);
    expect(result.text).toBe('tiny');
  });

  it('falls back to text-only path when text is empty and no poppler', async () => {
    const f = join(tmpDir, 'c.pdf');
    writeFileSync(f, 'EMPTY-PDF');
    const result = await new PdfParser().parse(f);
    // No poppler in test env, so vision fallback returns no images
    // and we degrade to text path.
    expect(result.extractMethod).toBe('text');
    expect(result.images).toBeUndefined();
  });
});
