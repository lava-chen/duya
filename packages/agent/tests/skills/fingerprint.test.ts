/**
 * fingerprintDir — mtime/size manifest hashing (plan 445 Phase A).
 *
 * Contract:
 *  - stable across repeated calls for an unchanged tree
 *  - reacts to content modification, new files, deletions, renames
 *  - reacts to mtime-only changes even when size is identical
 *  - null for a missing root
 *  - skips the same noise dirs as skill discovery (scanFilter)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintDir } from '../../src/skills/fingerprint.js';

describe('fingerprintDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'duya-fp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is stable for an unchanged tree', async () => {
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a', 'SKILL.md'), 'hello');

    const first = await fingerprintDir(root);
    const second = await fingerprintDir(root);

    expect(first).toBeTypeOf('string');
    expect(first).toBe(second);
  });

  it('changes when a file is modified', async () => {
    const file = join(root, 'SKILL.md');
    writeFileSync(file, 'v1');
    const before = await fingerprintDir(root);

    writeFileSync(file, 'v2 with different length');
    const after = await fingerprintDir(root);

    expect(after).not.toBe(before);
  });

  it('changes on mtime-only touch (same size)', async () => {
    const file = join(root, 'SKILL.md');
    writeFileSync(file, 'same-size');
    const before = await fingerprintDir(root);

    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    const after = await fingerprintDir(root);

    expect(after).not.toBe(before);
  });

  it('changes when files are added or removed', async () => {
    writeFileSync(join(root, 'one.md'), 'x');
    const one = await fingerprintDir(root);

    writeFileSync(join(root, 'two.md'), 'y');
    const two = await fingerprintDir(root);

    rmSync(join(root, 'one.md'));
    const three = await fingerprintDir(root);

    expect(two).not.toBe(one);
    expect(three).not.toBe(two);
    expect(three).not.toBe(one);
  });

  it('returns null for a missing root', async () => {
    expect(await fingerprintDir(join(root, 'nope'))).toBeNull();
  });

  it('ignores noise directories shared with discovery (scanFilter)', async () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'noise');
    const withoutNoise = await fingerprintDir(root);

    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'changed');
    const stillSame = await fingerprintDir(root);

    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref');
    const withDotGit = await fingerprintDir(root);

    expect(stillSame).toBe(withoutNoise);
    expect(withDotGit).toBe(withoutNoise);
  });
});
