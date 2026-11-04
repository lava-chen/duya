import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteTool } from '../src/WriteTool/WriteTool.js';
import {
  clearFileReadState,
  computeContentSha,
  recordFileRead,
  setReadFirstGateEnabled,
} from '../src/file-read-state.js';

let root: string;

function anchorFullRead(path: string): void {
  const s = statSync(path);
  const content = readFileSync(path, 'utf-8');
  recordFileRead(path, {
    mtimeMs: s.mtimeMs,
    size: s.size,
    isFullView: true,
    contentSha: computeContentSha(content),
  });
}

beforeEach(() => {
  clearFileReadState();
  setReadFirstGateEnabled(true);
  root = mkdtempSync(join(tmpdir(), 'duya-write-gate-'));
});

afterEach(() => {
  setReadFirstGateEnabled(true);
  clearFileReadState();
  rmSync(root, { recursive: true, force: true });
});

describe('WriteTool read-first gate (plan 448 Task E)', () => {
  it('creates a new file without a prior read', async () => {
    const path = join(root, 'new.txt');
    const result = await new WriteTool().execute({ file_path: path, content: 'hello\n' }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toBe('hello\n');
  });

  it('overwrites an empty existing file without a prior read', async () => {
    const path = join(root, 'empty.txt');
    writeFileSync(path, '');
    const result = await new WriteTool().execute({ file_path: path, content: 'filled\n' }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toBe('filled\n');
  });

  it('refuses to overwrite a non-empty unread file', async () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'original\n');
    const result = await new WriteTool().execute({ file_path: path, content: 'replaced\n' }, root);
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('File has not been read yet');
    expect(readFileSync(path, 'utf-8')).toBe('original\n');
  });

  it('overwrites a file that was read in this session', async () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'original\n');
    anchorFullRead(path);
    const result = await new WriteTool().execute({ file_path: path, content: 'replaced\n' }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toBe('replaced\n');
  });

  it('refuses to overwrite when the file changed after the read', async () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'original\n');
    anchorFullRead(path);
    writeFileSync(path, 'changed by someone else\n');
    const result = await new WriteTool().execute({ file_path: path, content: 'replaced\n' }, root);
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('modified after the last read');
    expect(readFileSync(path, 'utf-8')).toBe('changed by someone else\n');
  });

  it('allows an unread overwrite when the gate is disabled', async () => {
    setReadFirstGateEnabled(false);
    const path = join(root, 'a.txt');
    writeFileSync(path, 'original\n');
    const result = await new WriteTool().execute({ file_path: path, content: 'replaced\n' }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toBe('replaced\n');
  });
});
