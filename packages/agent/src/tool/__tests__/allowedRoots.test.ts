import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathWithinRoots } from '../allowedRoots.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-outside-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  mkdirSync(join(root, 'memory-config'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'hello');
  writeFileSync(join(outside, 'secret.txt'), 'shh');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isPathWithinRoots', () => {
  it('returns false for empty roots array (caller gates on allowedRoots?.length)', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [])).toBe(false);
  });

  it('returns false for non-absolute target path', () => {
    expect(isPathWithinRoots('relative/path.md', [root])).toBe(false);
  });

  it('returns false when no root is absolute', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), ['relative/root'])).toBe(false);
  });

  it('accepts a target inside the root', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [root])).toBe(true);
  });

  it('accepts a target equal to the root itself', () => {
    expect(isPathWithinRoots(root, [root])).toBe(true);
  });

  it('accepts a target inside one of several roots', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'duya-other-'));
    try {
      expect(isPathWithinRoots(join(otherRoot, 'x.md'), [root, otherRoot])).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects a target outside all roots', () => {
    expect(isPathWithinRoots(join(outside, 'secret.txt'), [root])).toBe(false);
  });

  it('rejects a sibling path that shares a string prefix with the root', () => {
    // Create a directory whose name starts with the root's name but is NOT
    // the root. A naive `startsWith` check would accept this.
    const sibling = root + '-evil';
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'stolen.md'), 'data');
    expect(isPathWithinRoots(join(sibling, 'stolen.md'), [root])).toBe(false);
  });

  it('rejects a non-existent root (skips it, falls through to other roots)', () => {
    const ghost = join(root, 'does-not-exist');
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [ghost, root])).toBe(true);
    expect(isPathWithinRoots(join(outside, 'secret.txt'), [ghost])).toBe(false);
  });

  describe('traversal', () => {
    it('rejects a path with .. that escapes the root lexically', () => {
      const escape = join(root, 'memory', '..', '..', '..', 'etc', 'passwd');
      expect(isPathWithinRoots(escape, [root])).toBe(false);
    });

    it('accepts a path with internal .. that stays inside the root', () => {
      mkdirSync(join(root, 'memory', 'sub'), { recursive: true });
      writeFileSync(join(root, 'memory', 'sub', 'b.md'), 'b');
      const inside = join(root, 'memory', 'sub', '..', 'b.md');
      expect(isPathWithinRoots(inside, [root])).toBe(true);
    });
  });

  describe('symlink escape', () => {
    let symlinkAttempted: boolean;
    beforeEach(() => { symlinkAttempted = false; });

    it('rejects a symlink inside the root that points outside', () => {
      const linkPath = join(root, 'memory', 'escape-link.md');
      try {
        symlinkSync(join(outside, 'secret.txt'), linkPath);
        symlinkAttempted = true;
      } catch {
        // Symlink creation may fail without privileges on some Windows builds.
      }
      if (!symlinkAttempted) return; // skip: cannot create symlink on this platform
      expect(isPathWithinRoots(linkPath, [root])).toBe(false);
    });

    it('accepts a symlink inside the root that points to another location inside the root', () => {
      const linkPath = join(root, 'memory', 'inner-link.md');
      try {
        symlinkSync(join(root, 'memory', 'a.md'), linkPath);
        symlinkAttempted = true;
      } catch {
        // skip on platforms without symlink privileges
      }
      if (!symlinkAttempted) return;
      expect(isPathWithinRoots(linkPath, [root])).toBe(true);
    });
  });

  describe('trailing separator', () => {
    it('treats root with trailing separator the same as without', () => {
      const rootWithSep = root + (process.platform === 'win32' ? '\\' : '/');
      expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [rootWithSep])).toBe(true);
    });

    it('treats target with trailing separator the same as without', () => {
      const dirTarget = join(root, 'memory') + (process.platform === 'win32' ? '\\' : '/');
      expect(isPathWithinRoots(dirTarget, [root])).toBe(true);
    });
  });
});