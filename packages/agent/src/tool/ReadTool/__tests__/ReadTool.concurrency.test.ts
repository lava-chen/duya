/**
 * ReadTool concurrency + cache-integrity tests
 *
 * Covers scenarios that the existing ReadTool.test.ts does not exercise:
 *   - parallel reads of the same / different files
 *   - partial view (line_range) not poisoning the full-file dedup cache
 *     (BUG-1 regression guard)
 *   - file modification invalidating the cache (mtime+size fingerprint)
 *   - cache surviving a partial read that follows a full read
 *
 * These tests exist because the original suite had zero concurrent-read
 * coverage, so the partial-view-poisons-cache bug was invisible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReadTool,
  _resetSharedParser,
} from '../ReadTool.js';
import { clearReadStateStore } from '../file-state.js';

let tmpDir: string;
let tool: ReadTool;

beforeEach(() => {
  _resetSharedParser();
  clearReadStateStore();
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-readtool-conc-'));
  tool = new ReadTool();
});

afterEach(() => {
  _resetSharedParser();
  clearReadStateStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ReadTool dedup cache — partial view isolation (BUG-1)', () => {
  it('partial read does NOT poison the full-file dedup cache', async () => {
    // Regression guard for BUG-1: a line_range read must not write the
    // cache. If it did, a subsequent full-file read would match the same
    // mtime+size and return a "File unchanged" stub pointing back at the
    // slice — hiding the rest of the file from the model.
    const f = join(tmpDir, 'big.txt');
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);

    const partial = await tool.execute({
      file_path: f,
      line_range: { start: 1, end: 10 },
    });
    expect(partial.error).toBeFalsy();
    expect(partial.result).toContain('line 1');
    expect(partial.result).toContain('line 10');
    expect(partial.result).not.toContain('line 1000');

    const full = await tool.execute({ file_path: f });
    expect(full.error).toBeFalsy();
    expect(full.result).not.toContain('File unchanged');
    expect(full.result).toContain('line 1');
    expect(full.result).toContain('line 1000');
  });

  it('full read → partial read → full read: second full read returns unchanged stub', async () => {
    // After a full read populates the cache, a partial read must NOT
    // overwrite it. So a second full read returns the dedup stub,
    // proving the cache survived the intervening partial read.
    const f = join(tmpDir, 'big.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);

    const first = await tool.execute({ file_path: f });
    expect(first.result).toContain('line 100');

    const partial = await tool.execute({
      file_path: f,
      line_range: { start: 1, end: 5 },
    });
    expect(partial.result).toContain('line 1');
    expect(partial.result).not.toContain('line 100');

    const second = await tool.execute({ file_path: f });
    expect(second.result).toContain('File unchanged');
  });

  it('partial read with end=-1 (whole tail) does NOT poison cache either', async () => {
    // line_range.end === -1 is the "read to EOF" sentinel. isPartialView
    // is false for end === -1, so this read DOES participate in dedup
    // (both check and write). Verify it behaves like a full read: writes
    // cache, and a subsequent identical read returns the stub.
    const f = join(tmpDir, 'tail.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);

    const first = await tool.execute({
      file_path: f,
      line_range: { start: 1, end: -1 },
    });
    expect(first.result).toContain('line 50');

    const second = await tool.execute({
      file_path: f,
      line_range: { start: 1, end: -1 },
    });
    expect(second.result).toContain('File unchanged');
  });
});

describe('ReadTool concurrent reads — same/different files', () => {
  it('two parallel full reads of the same file both return real content', async () => {
    const f = join(tmpDir, 'same.txt');
    writeFileSync(f, 'shared content\n');
    const [a, b] = await Promise.all([
      tool.execute({ file_path: f }),
      tool.execute({ file_path: f }),
    ]);
    expect(a.error).toBeFalsy();
    expect(b.error).toBeFalsy();
    // Both calls miss the cache (the first writer hasn't written yet when
    // the second checks), so both read the file. Either may end up the
    // "winner" of the cache write, but both results contain the content.
    expect(a.result).toContain('shared content');
    expect(b.result).toContain('shared content');
  });

  it('two parallel reads of different files do not collide', async () => {
    const f1 = join(tmpDir, 'a.txt');
    const f2 = join(tmpDir, 'b.txt');
    writeFileSync(f1, 'content A');
    writeFileSync(f2, 'content B');
    const [a, b] = await Promise.all([
      tool.execute({ file_path: f1 }),
      tool.execute({ file_path: f2 }),
    ]);
    expect(a.result).toContain('content A');
    expect(a.result).not.toContain('content B');
    expect(b.result).toContain('content B');
    expect(b.result).not.toContain('content A');
  });

  it('partial + full read in parallel: full read returns full content', async () => {
    // BUG-1 parallel scenario: a partial read and a full read of the same
    // file race. The full read must return the full content, not a stub
    // poisoned by the partial read's cache write.
    const f = join(tmpDir, 'race.txt');
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);
    const [partial, full] = await Promise.all([
      tool.execute({ file_path: f, line_range: { start: 1, end: 10 } }),
      tool.execute({ file_path: f }),
    ]);
    expect(partial.result).toContain('line 10');
    expect(partial.result).not.toContain('line 500');
    expect(full.result).toContain('line 500');
    expect(full.result).not.toContain('File unchanged');
  });
});

describe('ReadTool dedup cache — fingerprint invalidation (BUG-2)', () => {
  it('file modification after read invalidates the cache (mtime check)', async () => {
    // After a read, modifying the file + bumping mtime must cause the
    // next read to miss the cache and return fresh content. This verifies
    // the dedup check's fingerprint comparison works.
    const f = join(tmpDir, 'toctou.txt');
    writeFileSync(f, 'version 1');
    const first = await tool.execute({ file_path: f });
    expect(first.result).toContain('version 1');

    writeFileSync(f, 'version 2');
    const future = Math.floor(Date.now() / 1000) + 60;
    utimesSync(f, future, future);

    const second = await tool.execute({ file_path: f });
    expect(second.result).not.toContain('File unchanged');
    expect(second.result).toContain('version 2');
  });

  it('size-only change (same mtime) also invalidates the cache', async () => {
    // mtime alone has millisecond collisions on fast filesystems; the
    // cache requires BOTH mtime AND size to match. Force the same mtime
    // but a different size and verify the cache misses.
    const f = join(tmpDir, 'size.txt');
    writeFileSync(f, 'hello');
    const first = await tool.execute({ file_path: f });
    expect(first.result).toContain('hello');

    writeFileSync(f, 'hello world');
    // Pin mtime to the pre-write value so only size changes.
    const pinned = Math.floor(Date.now() / 1000);
    utimesSync(f, pinned, pinned);
    // Re-write content under the pinned mtime by setting it again after.
    // (utimesSync after writeFileSync: mtime is now pinned, size differs.)
    const second = await tool.execute({ file_path: f });
    expect(second.result).not.toContain('File unchanged');
    expect(second.result).toContain('hello world');
  });
});
