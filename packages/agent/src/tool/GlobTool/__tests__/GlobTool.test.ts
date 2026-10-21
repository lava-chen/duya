import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobTool, splitAbsoluteGlob } from '../GlobTool.js';
import { windowsPathToPosixPath } from '../../../utils/windowsPaths.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-glob-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-glob-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'a');
  writeFileSync(join(outside, 'o.md'), 'o');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('GlobTool basic', () => {
  it('finds files matching a pattern inside the working directory', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: '*.md' }, join(root, 'memory'));
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(process.platform !== 'win32')('GlobTool POSIX-shell paths (win32)', () => {
  it('resolves a Git Bash style search path (/e/...) instead of falling back to cwd', async () => {
    const msys = windowsPathToPosixPath(join(root, 'memory'));
    expect(msys).toMatch(/^\/[a-z]\//);
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: '*.md', path: msys });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });

  it('roots an absolute pattern given in POSIX drive form (/e/.../**/*.md)', async () => {
    const msys = windowsPathToPosixPath(join(root, 'memory'));
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: msys + '/**/*.md' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });
});

describe('GlobTool absolute pattern support', () => {
  it('globs an absolute pattern rooted at the pattern directory', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: join(root, 'memory', '**', '*.md') });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });

  it('globs an absolute pattern with a single-level wildcard', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: join(root, 'memory', '*.md') });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });

  it('rejects an absolute pattern outside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: join(outside, 'o.md') });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows an absolute pattern inside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: join(root, 'memory', 'a.md') });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBe(1);
  });

  it('splitAbsoluteGlob splits absolute globs into root + relative pattern', () => {
    expect(splitAbsoluteGlob(join(root, 'memory', '**', '*.md'))).toEqual({
      root: join(root, 'memory'),
      rel: '**/*.md',
    });
    expect(splitAbsoluteGlob(join(root, 'memory', 'a.md'))).toEqual({
      root: join(root, 'memory'),
      rel: 'a.md',
    });
  });

  it('splitAbsoluteGlob pins a bare drive letter to the drive root (win32)', () => {
    if (process.platform !== 'win32') {
      return; // drive-letter roots are win32-only path semantics
    }
    // Regression: "E:/*" used to split to root "E:" — a drive-relative
    // path that resolves to the cwd of drive E: (the workspace), so the
    // glob silently searched the wrong directory.
    expect(splitAbsoluteGlob('E:/*')).toEqual({ root: 'E:\\', rel: '*' });
    expect(splitAbsoluteGlob('E:/**/*.ts')).toEqual({ root: 'E:\\', rel: '**/*.ts' });
    expect(splitAbsoluteGlob('E:/foo*')).toEqual({ root: 'E:\\', rel: 'foo*' });
    // Non-drive-root absolute patterns are unaffected.
    expect(splitAbsoluteGlob('E:\\repo\\src\\**\\*.ts')).toEqual({
      root: 'E:\\repo\\src',
      rel: '**/*.ts',
    });
  });

  it('globs a drive-root pattern against the drive root, not the cwd (win32)', async () => {
    if (process.platform !== 'win32' || !existsSync('E:\\')) {
      return; // requires real Windows drive-letter semantics and an E: drive
    }
    const driveRootEntries = readdirSync('E:\\');
    const tool = new GlobTool();
    // maxResults: 1 keeps the walk bounded to the drive root level (the
    // walker would otherwise descend into every subdirectory of E:\)
    const result = await tool.execute({ pattern: 'E:/*', maxResults: 1 }, join(root, 'memory'));
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.filenames).toHaveLength(1);
    // The returned path is relative to the *drive root*: it must be a real
    // top-level entry of E:\. Regression: this used to resolve the bare
    // drive letter to the current directory of drive E: (the workspace cwd)
    // and returned workspace entries instead.
    expect(driveRootEntries).toContain(parsed.filenames[0]);
  });
});

describe('GlobTool allowedRoots sandbox', () => {
  it('rejects a glob whose path is outside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md', path: outside });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a glob inside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md', path: join(root, 'memory') });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });

  it('rejects a glob that defaults to a working directory outside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md' }, outside);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: '*.md' }, outside);
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });
});