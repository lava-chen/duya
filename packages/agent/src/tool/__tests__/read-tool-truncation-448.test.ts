/**
 * Plan 448 Phase 1 Task D: ReadTool truncates at complete UTF-8-safe line
 * boundaries within the byte budget and strips a leading UTF-8 BOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTool } from '../ReadTool/ReadTool.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-plan448-read-'));
  mkdirSync(join(root, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ReadTool truncation and BOM handling (plan 448)', () => {
  it('truncates CJK files at complete lines without replacement characters', async () => {
    // Each line is ~300 bytes of CJK; 50 lines ≈ 15KB. The 50KB budget is
    // not hit, so shrink the scenario: use lines long enough that the byte
    // cap lands mid-file but not mid-line. 200 lines × ~300B ≈ 60KB > 50KB.
    const cjk = '汉字测试'.repeat(50); // 200 chars × 3B = 600B per line
    const body = Array.from({ length: 200 }, (_, i) => `${i}:${cjk}`).join('\n');
    writeFileSync(join(root, 'src', 'big.txt'), body);

    const result = await new ReadTool().execute({ file_path: join(root, 'src', 'big.txt') }, root);
    expect(result.error).toBeFalsy();
    expect(result.result).not.toContain('\uFFFD'); // no mojibake at the cut
    expect(result.result).toContain('[Read metadata:');
  });

  it('strips a leading UTF-8 BOM from text output', async () => {
    writeFileSync(join(root, 'src', 'bom.txt'), '\uFEFFfirst line\nsecond line\n');
    const result = await new ReadTool().execute({ file_path: join(root, 'src', 'bom.txt') }, root);
    expect(result.error).toBeFalsy();
    expect(result.result.startsWith('File:')).toBe(true);
    expect(result.result).not.toContain('\uFEFF');
  });
});
