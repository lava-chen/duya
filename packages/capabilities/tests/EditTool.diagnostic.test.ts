import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../src/EditTool/EditTool.js';
import { clearFileReadState, recordFileRead } from '../src/file-read-state.js';

let root: string;

function markAsRead(path: string): void {
  const s = statSync(path);
  recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size });
}

beforeEach(() => {
  clearFileReadState();
  root = mkdtempSync(join(tmpdir(), 'duya-edit-diag-'));
});

afterEach(() => {
  clearFileReadState();
  rmSync(root, { recursive: true, force: true });
});

describe('not-found diagnostic (plan 448 Task K)', () => {
  it('quotes the lines around the closest match', async () => {
    const path = join(root, 'a.txt');
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1} content payload`).join('\n');
    writeFileSync(path, `${body}\n`);
    markAsRead(path);

    const result = await new EditTool().execute(
      { file_path: path, old_string: 'line 20 content payload TYPO', new_string: 'x' },
      root,
    );

    expect(result.error).toBe(true);
    const text = String(result.result);
    expect(text).toContain('Closest match: line 20');
    expect(text).toContain('File lines 15-25 (closest match in context):');
    expect(text).toContain('| line 20 content payload');
  });

  it('bounds the attached snippet to 800 characters', async () => {
    const path = join(root, 'long.txt');
    const body = Array.from({ length: 12 }, (_, i) => `${i + 1}: ${'x'.repeat(400)}`).join('\n');
    writeFileSync(path, `${body}\n`);
    markAsRead(path);

    const result = await new EditTool().execute(
      { file_path: path, old_string: '1: yyyyy', new_string: 'z' },
      root,
    );

    const text = String(result.result);
    // The snippet block is the "File lines" header plus every following
    // numbered line; the diagnostic continues with unnumbered sections.
    const lines = text.split('\n');
    const headerIdx = lines.findIndex((line) => line.startsWith('File lines'));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    let end = headerIdx + 1;
    while (end < lines.length && /^\s*\d+ \| /.test(lines[end])) end++;
    const snippet = lines.slice(headerIdx, end).join('\n');
    expect(snippet.length).toBeLessThanOrEqual(800);
  });

  it('never splits a surrogate pair when truncating a long line', async () => {
    const path = join(root, 'emoji.txt');
    writeFileSync(path, `${'😀'.repeat(1200)}\n`);
    markAsRead(path);

    const result = await new EditTool().execute(
      { file_path: path, old_string: `${'😀'.repeat(1200)}X`, new_string: 'z' },
      root,
    );

    const text = String(result.result);
    const start = text.indexOf('File lines');
    expect(start).toBeGreaterThanOrEqual(0);
    const snippet = text.slice(start);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(snippet)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(snippet)).toBe(false);
  });
});
