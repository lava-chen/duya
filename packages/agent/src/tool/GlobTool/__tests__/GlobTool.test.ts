import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobTool, splitAbsoluteGlob } from '../GlobTool.js';

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