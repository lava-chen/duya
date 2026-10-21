import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteTool } from '../WriteTool.js';

let root: string;
let outside: string;
let tool: WriteTool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-write-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-write-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  tool = new WriteTool();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('WriteTool basic', () => {
  it('writes content to a file inside the working directory', async () => {
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'new.md'), content: 'hello' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(existsSync(join(root, 'memory', 'new.md'))).toBe(true);
    expect(readFileSync(join(root, 'memory', 'new.md'), 'utf-8')).toBe('hello');
  });

  it('creates parent directories when they do not exist', async () => {
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'sub', 'deep.md'), content: 'deep' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'sub', 'deep.md'), 'utf-8')).toBe('deep');
  });
});

describe('WriteTool allowedRoots sandbox', () => {
  it('rejects a write outside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(outside, 'stolen.md'), content: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    expect(existsSync(join(outside, 'stolen.md'))).toBe(false);
  });

  it('allows a write inside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'ok.md'), content: 'ok' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'ok.md'), 'utf-8')).toBe('ok');
  });

  it('allows writing a new file whose parent exists inside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'brand-new.md'), content: 'brand' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'brand-new.md'), 'utf-8')).toBe('brand');
  });

  it('rejects a write that uses .. to escape allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const escape = join(root, 'memory', '..', '..', 'escape.md');
    const result = await sandboxed.execute({ file_path: escape, content: 'x' }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const result = await tool.execute(
      { file_path: join(outside, 'free.md'), content: 'free' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(outside, 'free.md'), 'utf-8')).toBe('free');
  });
});