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