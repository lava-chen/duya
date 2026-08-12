import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from '../GrepTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-grep-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-grep-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'needle in haystack\nsecond line\n');
  writeFileSync(join(outside, 'o.md'), 'needle outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('GrepTool basic', () => {
  it('finds matches inside the working directory', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });
});

describe('GrepTool allowedRoots sandbox', () => {
  it('rejects a search whose path is outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle', path: outside });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a search inside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('rejects a search that defaults to a working directory outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: outside,
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new GrepTool({ workingDirectory: outside });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
  });
});

describe('GrepTool single-file search', () => {
  it('returns matches when searching a single file path (--with-filename)', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const singleFile = join(root, 'memory', 'a.md');
    const result = await tool.execute({ pattern: 'needle', path: singleFile });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.matches[0].content).toContain('needle');
    expect(parsed.matches[0].file).toBe('a.md');
  });
});

describe('GrepTool long line truncation', () => {
  it('truncates matching lines that exceed the max length', async () => {
    const longLine = 'needle ' + 'x'.repeat(5000);
    writeFileSync(join(root, 'memory', 'long.md'), longLine + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const content = parsed.matches[0].content as string;
    expect(content.length).toBeLessThan(1200);
    expect(content).toContain('line truncated');
  });
});

describe('GrepTool result limit', () => {
  it('caps results and marks truncated when max_results is exceeded', async () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(root, 'memory', 'many.md'), manyLines + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', max_results: 10 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.total).toBeLessThanOrEqual(10);
    expect(parsed.truncated).toBe(true);
  });

  it('defaults to 100 results matching the documented schema', async () => {
    const manyLines = Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(root, 'memory', 'many.md'), manyLines + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.total).toBeLessThanOrEqual(100);
  });
});

describe('GrepTool relative paths', () => {
  it('returns paths relative to the search base (no drive letter)', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const file = parsed.matches[0].file as string;
    expect(file).toBe('a.md');
    expect(file).not.toMatch(/^[A-Za-z]:/);
  });
});