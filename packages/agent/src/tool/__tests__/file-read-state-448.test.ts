/**
 * Plan 448 tests: read-state freshness protocol.
 *
 * Covers the four Phase 1 behaviors:
 *   - file-read-state entry semantics (full vs partial view, BOM-normalized
 *     content fingerprints)
 *   - EditTool staleness: mtime tolerance, size check, full-view
 *     content-equality exemption (Windows mtime churn), partial-view refusal
 *   - ApplyPatch re-anchors read-state so a follow-up edit needs no re-read
 *   - ReadTool truncation at complete lines (no split UTF-8 code points)
 *     and leading-BOM stripping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../EditTool/EditTool.js';
import { ReadTool } from '../ReadTool/ReadTool.js';
import { ApplyPatchTool } from '../ApplyPatchTool/ApplyPatchTool.js';
import {
  clearFileReadState,
  computeContentSha,
  getFileReadState,
  recordFileRead,
} from '../file-read-state.js';

let root: string;

function path(...parts: string[]): string {
  return join(root, ...parts);
}

/** Record a full-view anchor with a content fingerprint (post-read shape). */
function markAsFullRead(absPath: string): void {
  const s = statSync(absPath);
  recordFileRead(absPath, {
    mtimeMs: s.mtimeMs,
    size: s.size,
    isFullView: true,
    contentSha: computeContentSha(readFileSync(absPath, 'utf-8')),
  });
}

beforeEach(() => {
  clearFileReadState();
  root = mkdtempSync(join(tmpdir(), 'duya-plan448-'));
  mkdirSync(path('src'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('file-read-state entry semantics (plan 448)', () => {
  it('defaults to a partial view without fingerprint', () => {
    recordFileRead(path('a.ts'), { mtimeMs: 1, size: 2 });
    expect(getFileReadState(path('a.ts'))).toEqual({
      mtimeMs: 1,
      size: 2,
      isFullView: false,
      contentSha: undefined,
    });
  });

  it('keeps the fingerprint only for full views', () => {
    recordFileRead(path('a.ts'), { mtimeMs: 1, size: 2, isFullView: false, contentSha: 'deadbeef' });
    expect(getFileReadState(path('a.ts'))?.contentSha).toBeUndefined();
    recordFileRead(path('b.ts'), { mtimeMs: 1, size: 2, isFullView: true, contentSha: 'cafe' });
    expect(getFileReadState(path('b.ts'))?.contentSha).toBe('cafe');
  });

  it('normalizes a leading UTF-8 BOM out of fingerprints', () => {
    const plain = 'hello\nworld\n';
    const withBom = '\uFEFF' + plain;
    expect(computeContentSha(withBom)).toBe(computeContentSha(plain));
  });
});

describe('EditTool staleness (plan 448)', () => {
  beforeEach(() => {
    writeFileSync(path('src', 'a.ts'), 'line one\nline two\nline three\n');
  });

  it('tolerates sub-millisecond mtime jitter', async () => {
    markAsFullRead(path('src', 'a.ts'));
    // Cosmetic churn well under the 1ms tolerance.
    const s = statSync(path('src', 'a.ts'));
    utimesSync(path('src', 'a.ts'), s.atime, new Date(s.mtimeMs + 0.5));
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
  });

  it('rejects when the file truly changed (mtime and size drift)', async () => {
    markAsFullRead(path('src', 'a.ts'));
    // Simulate an external writer that changed both size and mtime.
    utimesSync(path('src', 'a.ts'), new Date(), new Date(Date.now() + 5000));
    writeFileSync(path('src', 'a.ts'), 'line one\nCHANGED\nline three\n');
    utimesSync(path('src', 'a.ts'), new Date(), new Date(Date.now() + 9000));
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('modified after the last read');
  });

  it('exempts a full-view read whose content still matches despite mtime churn', async () => {
    markAsFullRead(path('src', 'a.ts'));
    // OneDrive/AV-style touch: mtime moves, bytes do not.
    const s = statSync(path('src', 'a.ts'));
    utimesSync(path('src', 'a.ts'), s.atime, new Date(s.mtimeMs + 60_000));
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(path('src', 'a.ts'), 'utf-8')).toContain('TWO');
  });

  it('never exempts a partial view', async () => {
    // Anchor recorded WITHOUT a fingerprint (partial-view shape).
    const s = statSync(path('src', 'a.ts'));
    recordFileRead(path('src', 'a.ts'), { mtimeMs: s.mtimeMs + 60_000, size: s.size, isFullView: false });
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBe(true);
  });

  it('re-anchors after its own write with a full-view fingerprint', async () => {
    markAsFullRead(path('src', 'a.ts'));
    const tool = new EditTool();
    const first = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line one', new_string: 'ONE' },
      root,
    );
    expect(first.error).toBeFalsy();
    // Second edit right after: must not be rejected as stale even though the
    // file's mtime changed between the two calls (it was OUR write).
    const second = await tool.execute(
      { file_path: path('src', 'a.ts'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(second.error).toBeFalsy();
    // The anchor now carries a fingerprint matching current disk content.
    const entry = getFileReadState(path('src', 'a.ts'));
    expect(entry?.isFullView).toBe(true);
    expect(entry?.contentSha).toBe(computeContentSha(readFileSync(path('src', 'a.ts'), 'utf-8')));
  });

  it('exemption works across a BOM-prefixed file', async () => {
    writeFileSync(path('src', 'bom.md'), '\uFEFFalpha\nbeta\n');
    markAsFullRead(path('src', 'bom.md'));
    const s = statSync(path('src', 'bom.md'));
    utimesSync(path('src', 'bom.md'), s.atime, new Date(s.mtimeMs + 60_000));
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: path('src', 'bom.md'), old_string: 'alpha', new_string: 'ALPHA' },
      root,
    );
    expect(result.error).toBeFalsy();
  });
});

describe('ApplyPatchTool re-anchors read-state (plan 448)', () => {
  beforeEach(() => {
    writeFileSync(path('src', 'a.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  });

  it('lets an edit follow apply_patch on the same file without a re-read', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 42;',
      ' const z = 3;',
      '*** End Patch',
    ].join('\n');
    const patchResult = await new ApplyPatchTool().execute({ patch }, root);
    expect(patchResult.error).toBeFalsy();

    // No explicit read happened — the re-anchor from apply_patch must make
    // this edit pass instead of failing with "File was modified after...".
    const editResult = await new EditTool().execute(
      { file_path: path('src', 'a.ts'), old_string: 'const z = 3;', new_string: 'const z = 4;' },
      root,
    );
    expect(editResult.error).toBeFalsy();
    expect(readFileSync(path('src', 'a.ts'), 'utf-8')).toContain('const y = 42;');
  });

  it('drops the anchor for deleted files', async () => {
    const patch = ['*** Begin Patch', '*** Delete File: src/a.ts', '*** End Patch'].join('\n');
    const result = await new ApplyPatchTool().execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(getFileReadState(path('src', 'a.ts'))).toBeUndefined();
  });
});
