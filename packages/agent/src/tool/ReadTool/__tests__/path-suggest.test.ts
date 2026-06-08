/**
 * path-suggest.test.ts
 *
 * Verifies ENOENT-friendly suggestions: macOS thin-space screenshot
 * fix, similar-filename Levenshtein lookup, and cwd-relative hints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAlternateScreenshotPath,
  findSimilarFile,
  suggestPathUnderCwd,
} from '../path-suggest.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-pathsug-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAlternateScreenshotPath', () => {
  it('returns thin-space variant for regular-space macOS filename', () => {
    const alt = getAlternateScreenshotPath('/Users/foo/Desktop/Screen Shot 2026-06-08 at 10.00 AM.png');
    expect(alt).toBe('/Users/foo/Desktop/Screen Shot 2026-06-08 at 10.00 AM.png');
  });

  it('returns regular-space variant for thin-space filename', () => {
    const alt = getAlternateScreenshotPath('/Users/foo/Desktop/Screen Shot 2026-06-08 at 10.00 AM.png');
    expect(alt).toBe('/Users/foo/Desktop/Screen Shot 2026-06-08 at 10.00 AM.png');
  });

  it('returns undefined for non-screenshot filenames', () => {
    expect(getAlternateScreenshotPath('/etc/passwd')).toBeUndefined();
    expect(getAlternateScreenshotPath('report.pdf')).toBeUndefined();
    expect(getAlternateScreenshotPath('plain.txt')).toBeUndefined();
  });

  it('returns undefined for non-png screenshot-like names', () => {
    expect(getAlternateScreenshotPath('/Users/foo/Screen Shot 2026-06-08 at 10.00 AM.jpg')).toBeUndefined();
  });
});

describe('findSimilarFile', () => {
  it('finds a typo-corrected sibling', () => {
    writeFileSync(join(tmpDir, 'config.json'), '{}');
    const similar = findSimilarFile(join(tmpDir, 'confg.json'));
    expect(similar).toBe(join(tmpDir, 'config.json'));
  });

  it('uses case-insensitive comparison when scoring candidates', () => {
    // README vs readme are distance 0 in lowercase, so we use a name
    // that's one char off (case difference) — confirms the algorithm
    // matches by lowercase without requiring the file system to be
    // case-insensitive.
    writeFileSync(join(tmpDir, 'README.md'), '# readme');
    // "readmee.md" is distance 1 from "readme.md" which is the
    // lowercase form of README.md. Should be suggested.
    const similar = findSimilarFile(join(tmpDir, 'readmee.md'));
    expect(similar).toBe(join(tmpDir, 'README.md'));
  });

  it('returns undefined when nothing is close enough', () => {
    writeFileSync(join(tmpDir, 'a.txt'), '');
    const similar = findSimilarFile(join(tmpDir, 'totally-different-name.png'));
    expect(similar).toBeUndefined();
  });

  it('returns undefined when the directory does not exist', () => {
    expect(findSimilarFile(join(tmpDir, 'nope', 'foo.txt'))).toBeUndefined();
  });

  it('skips an exact-match entry', () => {
    writeFileSync(join(tmpDir, 'exact.txt'), '');
    // If "exact.txt" exists, looking for it should return undefined
    // (we're suggesting OTHER files, not the requested one)
    const similar = findSimilarFile(join(tmpDir, 'exact.txt'));
    expect(similar).toBeUndefined();
  });
});

describe('suggestPathUnderCwd', () => {
  it('returns the absolute path when a relative file exists under cwd', () => {
    writeFileSync(join(tmpDir, 'data.txt'), 'x');
    expect(suggestPathUnderCwd('data.txt', tmpDir)).toBe(join(tmpDir, 'data.txt'));
  });

  it('returns undefined for paths that do not resolve under cwd', () => {
    expect(suggestPathUnderCwd('missing.txt', tmpDir)).toBeUndefined();
  });

  it('returns undefined for absolute paths (no suggestion to make)', () => {
    expect(suggestPathUnderCwd('/etc/passwd', tmpDir)).toBeUndefined();
    expect(suggestPathUnderCwd('C:\\Windows\\System32', tmpDir)).toBeUndefined();
  });

  it('returns undefined when cwd is undefined', () => {
    expect(suggestPathUnderCwd('data.txt', undefined)).toBeUndefined();
  });
});
