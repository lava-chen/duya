/**
 * ReadTool concurrency tests
 *
 * Covers parallel reads of the same / different files, and a racing
 * partial (line_range) + full read of the same file. With the dedup
 * stub removed, every read returns the full deterministic content, so
 * these tests pin the concurrency safety of the read path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReadTool,
  _resetSharedParser,
} from '../ReadTool.js';

let tmpDir: string;
let tool: ReadTool;

beforeEach(() => {
  _resetSharedParser();
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-readtool-conc-'));
  tool = new ReadTool();
});

afterEach(() => {
  _resetSharedParser();
  rmSync(tmpDir, { recursive: true, force: true });
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

  it('partial + full read of the same file in parallel: full returns full content', async () => {
    const f = join(tmpDir, 'race.txt');
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);
    const [partial, full] = await Promise.all([
      tool.execute({ file_path: f, line_range: { start: 1, end: 10 } }),
      tool.execute({ file_path: f }),
    ]);
    expect(partial.error).toBeFalsy();
    expect(partial.result).toContain('line 10');
    expect(partial.result).not.toContain('line 500');
    expect(full.error).toBeFalsy();
    expect(full.result).toContain('line 1');
    expect(full.result).toContain('line 500');
  });
});