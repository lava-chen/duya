import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../EditTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-edit-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-edit-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'line one\nline two\nline three\n');
  writeFileSync(join(outside, 'o.md'), 'outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('EditTool basic', () => {
  it('replaces a unique string in a file', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'a.md'), 'utf-8')).toContain('TWO');
  });

  it('errors when old_string is not found', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'nope', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
  });
});

describe('EditTool allowedRoots sandbox', () => {
  it('rejects an edit outside allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(outside, 'o.md'), old_string: 'outside', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    // Content unchanged
    expect(readFileSync(join(outside, 'o.md'), 'utf-8')).toBe('outside\n');
  });

  it('allows an edit inside allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'a.md'), 'utf-8')).toContain('TWO');
  });

  it('rejects an edit that uses .. to escape allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const escape = join(root, 'memory', '..', '..', 'o.md');
    const result = await sandboxed.execute(
      { file_path: escape, old_string: 'outside', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(outside, 'o.md'), old_string: 'outside', new_string: 'OUT' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(outside, 'o.md'), 'utf-8')).toContain('OUT');
  });
});