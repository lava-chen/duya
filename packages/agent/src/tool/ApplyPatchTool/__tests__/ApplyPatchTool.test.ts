import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyPatchTool, parseCodexPatch, applyHunkToLines } from '../ApplyPatchTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-patch-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-patch-out-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\nconst z = 4;\n');
  writeFileSync(join(outside, 'o.ts'), 'outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('parseCodexPatch', () => {
  it('parses add/update/delete operations', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const a = 1;
+export const b = 2;
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** Delete File: src/old.ts
*** End Patch`;
    const ops = parseCodexPatch(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ kind: 'add', path: 'src/new.ts' });
    expect(ops[0].content).toBe('export const a = 1;\nexport const b = 2;');
    expect(ops[1]).toMatchObject({ kind: 'update', path: 'src/a.ts' });
    expect(ops[1].hunks).toHaveLength(1);
    expect(ops[2]).toMatchObject({ kind: 'delete', path: 'src/old.ts' });
  });

  it('throws when no Begin Patch marker found', () => {
    expect(() => parseCodexPatch('no marker here')).toThrow('Begin Patch');
  });

  it('throws on empty operations', () => {
    expect(() => parseCodexPatch('*** Begin Patch\n*** End Patch')).toThrow('no file operations');
  });
});

describe('applyHunkToLines', () => {
  it('replaces a removed line with an added line', () => {
    const lines = ['a', 'b', 'c'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(true);
    expect(result.lines).toEqual(['a', 'B', 'c']);
  });

  it('tolerates trailing-whitespace drift on the file', () => {
    const lines = ['a', 'b   ', 'c'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(true);
    expect(result.lines).toEqual(['a', 'B', 'c']);
  });

  it('returns failure when context does not match', () => {
    const lines = ['x', 'y', 'z'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(false);
  });

  it('returns failure when ambiguous (multiple matches)', () => {
    const lines = ['b', 'b'];
    const hunk = { lines: ['-b', '+B'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(false);
  });
});

describe('ApplyPatchTool execute', () => {
  it('updates a single file', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
  });

  it('adds a new file', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const a = 1;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf-8')).toContain('export const a = 1;');
  });

  it('deletes a file', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'old.ts'), 'old\n');
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(existsSync(join(root, 'src', 'old.ts'))).toBe(false);
  });

  it('applies multiple files in one call', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'b.ts'), 'const p = 1;\nconst q = 2;\n');
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** Update File: src/b.ts
@@
 const p = 1;
-const q = 2;
+const q = 9;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf-8')).toContain('const q = 9;');
  });

  it('handles CRLF files', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'crlf.ts'), 'a\r\nb\r\nc\r\n');
    const patch = `*** Begin Patch
*** Update File: src/crlf.ts
@@
 a
-b
+B
 c
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'crlf.ts'), 'utf-8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('rejects a path outside allowedRoots', async () => {
    const tool = new ApplyPatchTool({ allowedRoots: [join(root, 'src')] });
    const patch = `*** Begin Patch
*** Update File: ${join(outside, 'o.ts')}
@@
-outside
+INSIDE
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    expect(readFileSync(join(outside, 'o.ts'), 'utf-8')).toBe('outside\n');
  });

  it('reports a failed hunk as a partial failure', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 does not exist anywhere
-const y = 2;
+const y = 3;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    // Verification read-back reports the failed hunk with the real context
    // lines so the model can fix the hunk in place.
    expect(result.result).toContain('Failed to find expected lines in src/a.ts');
    expect(result.result).toContain('Actual lines near the failure');
    // Content unchanged
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 2;');
  });
});