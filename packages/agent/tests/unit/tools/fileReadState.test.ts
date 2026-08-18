import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../../../src/tool/EditTool/EditTool.js';
import { ReadTool } from '../../../src/tool/ReadTool/ReadTool.js';
import { WriteTool } from '../../../src/tool/WriteTool/WriteTool.js';
import {
  recordFileRead,
  getFileReadState,
  invalidateFileRead,
  clearFileReadState,
} from '../../../src/tool/file-read-state.js';

let root: string;

beforeEach(() => {
  clearFileReadState();
  root = mkdtempSync(join(tmpdir(), 'duya-read-state-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearFileReadState();
});

describe('edit read-state anchoring (plan 428)', () => {
  it('rejects an edit when the file was never read', async () => {
    const file = join(root, 'unread.md');
    writeFileSync(file, 'alpha\nbeta\n');
    const result = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('has not been read');
    expect(result.result).toContain('read');
    expect(result.result).toContain(file);
    // Content untouched.
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nbeta\n');
  });

  it('allows an edit after a full read', async () => {
    const file = join(root, 'full.md');
    writeFileSync(file, 'alpha\nbeta\n');
    const read = await new ReadTool().execute({ file_path: file }, root);
    expect(read.error).toBeFalsy();
    const result = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nBETA\n');
  });

  it('allows an edit after a line_range read (mtime is the anchor)', async () => {
    const file = join(root, 'range.md');
    writeFileSync(file, 'one\ntwo\nthree\nfour\n');
    const read = await new ReadTool().execute(
      { file_path: file, line_range: { start: 2, end: 3 } },
      root,
    );
    expect(read.error).toBeFalsy();
    const result = await new EditTool().execute(
      { file_path: file, old_string: 'three', new_string: 'THREE' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\nTHREE\nfour\n');
  });

  it('rejects an edit when mtime changed after the read (external modification)', async () => {
    const file = join(root, 'stale.md');
    writeFileSync(file, 'alpha\nbeta\n');
    const read = await new ReadTool().execute({ file_path: file }, root);
    expect(read.error).toBeFalsy();

    // Simulate an external writer (bash / apply_patch / editor) that touches
    // the file after our read. utimes gives a deterministic mtime bump.
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);

    const result = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('modified after the last read');
    expect(result.result).toContain('Re-read');
    // Content untouched.
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nbeta\n');

    // Re-reading refreshes the anchor and the edit goes through.
    const reread = await new ReadTool().execute({ file_path: file }, root);
    expect(reread.error).toBeFalsy();
    const retry = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(retry.error).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nBETA\n');
  });

  it('allows consecutive edits without a re-read between them', async () => {
    const file = join(root, 'twice.md');
    writeFileSync(file, 'alpha\nbeta\n');
    await new ReadTool().execute({ file_path: file }, root);

    const first = await new EditTool().execute(
      { file_path: file, old_string: 'alpha', new_string: 'ALPHA' },
      root,
    );
    expect(first.error).toBeFalsy();

    // The second edit must NOT be rejected by the first edit's own write —
    // a successful edit re-anchors the read state to the bytes it wrote.
    const second = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(second.error).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('ALPHA\nBETA\n');
  });

  it('allows an edit right after a write (write-then-edit flow)', async () => {
    const file = join(root, 'written.md');
    const write = await new WriteTool().execute(
      { file_path: file, content: 'alpha\nbeta\n' },
      root,
    );
    expect(write.error).toBeFalsy();
    const result = await new EditTool().execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nBETA\n');
  });
});

describe('file-read-state module', () => {
  it('records, retrieves, and invalidates entries', () => {
    const file = join(root, 'norm.md');
    writeFileSync(file, 'x\n');
    const s = statSync(file);
    recordFileRead(file, { mtimeMs: s.mtimeMs, size: s.size });
    expect(getFileReadState(file)).toEqual({ mtimeMs: s.mtimeMs, size: s.size });
    invalidateFileRead(file);
    expect(getFileReadState(file)).toBeUndefined();
  });

  it('normalizes path variants to one entry', () => {
    const file = join(root, 'norm.md');
    writeFileSync(file, 'x\n');
    const s = statSync(file);
    recordFileRead(file, { mtimeMs: s.mtimeMs, size: s.size });
    // Forward-slash / ..-laden variants resolve to the same entry.
    const variant = file.replace(/\\/g, '/').replace('/norm.md', '/./norm.md');
    expect(getFileReadState(variant)).toEqual({ mtimeMs: s.mtimeMs, size: s.size });
  });
});
