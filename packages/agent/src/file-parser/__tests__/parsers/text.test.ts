/**
 * text parser smoke test
 * Verifies utf-8 + BOM handling against on-disk files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextParser } from '../../parsers/text.js';

describe('TextParser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-text-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads plain utf-8', async () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello world', 'utf-8');
    const out = await new TextParser().parse(f);
    expect(out.text).toBe('hello world');
    expect(out.extractMethod).toBe('text');
  });

  it('strips BOM', async () => {
    const f = join(tmpDir, 'bom.txt');
    writeFileSync(f, '﻿hello', 'utf-8');
    const out = await new TextParser().parse(f);
    expect(out.text).toBe('hello');
  });

  it('treats .md same as .txt', async () => {
    const f = join(tmpDir, 'a.md');
    writeFileSync(f, '# heading\n\nbody', 'utf-8');
    const out = await new TextParser().parse(f);
    expect(out.text).toContain('# heading');
    expect(out.text).toContain('body');
  });
});
