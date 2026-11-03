import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../src/EditTool/EditTool.js';
import { WriteTool } from '../src/WriteTool/WriteTool.js';
import { ApplyPatchTool } from '../src/ApplyPatchTool/ApplyPatchTool.js';
import { buildFileDiff, MAX_DIFF_ROWS } from '../src/file-diff.js';
import { recordFileRead, clearFileReadState } from '../src/file-read-state.js';
import {
  TOOL_FILE_DIFF_METADATA_KEY,
  parseToolFileDiff,
  type ToolFileDiff,
} from '@duya/agent-protocol/tool-file-diff';

let root: string;

function markAsRead(path: string): void {
  const s = statSync(path);
  recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size });
}

function diffsOf(result: { metadata?: Record<string, unknown> }): ToolFileDiff[] {
  const parsed = parseToolFileDiff(result.metadata?.[TOOL_FILE_DIFF_METADATA_KEY]);
  expect(parsed).not.toBeNull();
  return parsed ?? [];
}

beforeEach(() => {
  clearFileReadState();
  root = mkdtempSync(join(tmpdir(), 'duya-file-diff-'));
  mkdirSync(join(root, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildFileDiff', () => {
  it('returns null when the two versions are identical', () => {
    expect(buildFileDiff({ path: 'a.ts', oldText: 'same\n', newText: 'same\n' })).toBeNull();
  });

  it('reports added, removed and context rows with their line numbers', () => {
    const diff = buildFileDiff({
      path: 'a.ts',
      oldText: 'a\nb\nc\nd\ne\n',
      newText: 'a\nb\nX\nd\ne\n',
    });
    expect(diff).not.toBeNull();
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
    const rows = diff?.hunks[0]?.lines ?? [];
    expect(rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine])).toEqual([
      ['context', 'a', 1, 1],
      ['context', 'b', 2, 2],
      ['remove', 'c', 3, null],
      ['add', 'X', null, 3],
      ['context', 'd', 4, 4],
      ['context', 'e', 5, 5],
    ]);
  });

  it('drops the rows but keeps the counts when the diff is too large', () => {
    const oldText = Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 300 }, (_, i) => `new ${i}`).join('\n');
    const diff = buildFileDiff({ path: 'big.ts', oldText, newText });
    expect(diff?.truncated).toBe(true);
    expect(diff?.hunks).toEqual([]);
    // The counts stay exact so a summary line remains truthful.
    expect(diff?.added).toBe(300);
    expect(diff?.removed).toBe(300);
  });

  it('drops the rows when the diff exceeds the byte budget', () => {
    const oldText = Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n');
    const newText = Array.from({ length: 100 }, () => 'y'.repeat(1000)).join('\n');
    const diff = buildFileDiff({ path: 'wide.ts', oldText, newText });
    expect(diff?.truncated).toBe(true);
    expect(diff?.hunks).toEqual([]);
  });

  it('keeps a diff whose row count is within the budget', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 10 }, (_, i) => `new ${i}`).join('\n');
    const diff = buildFileDiff({ path: 'small.ts', oldText, newText });
    expect(diff?.truncated).toBeUndefined();
    expect(diff?.hunks.length).toBeGreaterThan(0);
    expect(MAX_DIFF_ROWS).toBeGreaterThan(0);
  });
});

describe('edit tool publishes a structured diff', () => {
  it('carries the changed rows with their line numbers', async () => {
    const file = join(root, 'src', 'a.md');
    writeFileSync(file, 'line one\nline two\nline three\n');
    markAsRead(file);

    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: file, old_string: 'line two', new_string: 'TWO' },
      root,
    );

    expect(result.error).toBeFalsy();
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe(file);
    expect(diffs[0]?.added).toBe(1);
    expect(diffs[0]?.removed).toBe(1);
    const rows = diffs[0]?.hunks[0]?.lines ?? [];
    expect(rows.some((r) => r.kind === 'remove' && r.text === 'line two' && r.oldLine === 2)).toBe(true);
    expect(rows.some((r) => r.kind === 'add' && r.text === 'TWO' && r.newLine === 2)).toBe(true);
  });

  it('publishes no diff when the edit failed', async () => {
    const file = join(root, 'src', 'b.md');
    writeFileSync(file, 'line one\n');
    markAsRead(file);

    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: file, old_string: 'not there', new_string: 'x' },
      root,
    );

    expect(result.error).toBe(true);
    expect(result.metadata?.[TOOL_FILE_DIFF_METADATA_KEY]).toBeUndefined();
  });
});

describe('write tool publishes a structured diff', () => {
  it('reports every line as an addition for a new file', async () => {
    const file = join(root, 'src', 'new.ts');
    const tool = new WriteTool();
    const result = await tool.execute({ file_path: file, content: 'a\nb\n' }, root);

    expect(result.error).toBeFalsy();
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.added).toBe(2);
    expect(diffs[0]?.removed).toBe(0);
    const rows = diffs[0]?.hunks[0]?.lines ?? [];
    expect(rows.every((r) => r.kind === 'add')).toBe(true);
    expect(rows.map((r) => r.newLine)).toEqual([1, 2]);
  });

  it('reports the replaced lines when an existing file is overwritten', async () => {
    const file = join(root, 'src', 'old.ts');
    writeFileSync(file, 'a\nb\nc\n');
    const tool = new WriteTool();
    const result = await tool.execute({ file_path: file, content: 'a\nB\nc\n' }, root);

    expect(result.error).toBeFalsy();
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.added).toBe(1);
    expect(diffs[0]?.removed).toBe(1);
    const rows = diffs[0]?.hunks[0]?.lines ?? [];
    expect(rows.some((r) => r.kind === 'remove' && r.text === 'b' && r.oldLine === 2)).toBe(true);
    expect(rows.some((r) => r.kind === 'add' && r.text === 'B' && r.newLine === 2)).toBe(true);
  });

  it('reports the write path so same-file writes stay ordered', () => {
    const tool = new WriteTool();
    expect(tool.extractWritePaths({ file_path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(tool.extractWritePaths({ path: 'src/a.ts' })).toEqual(['__unknown__']);
  });
});

describe('apply_patch publishes a structured diff', () => {
  it('carries one diff per file the patch changed', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'const p = 1;\n');

    const tool = new ApplyPatchTool();
    const result = await tool.execute(
      {
        patch: `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
*** Update File: src/b.ts
@@
-const p = 1;
+const p = 2;
*** End Patch`,
      },
      root,
    );

    expect(result.error).toBeFalsy();
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(2);
    expect(diffs.map((d) => d.path.endsWith('a.ts'))).toEqual([true, false]);
    expect(diffs[0]?.added).toBe(1);
    expect(diffs[0]?.removed).toBe(1);
  });

  it('publishes a diff for an added file and for a deleted file', async () => {
    writeFileSync(join(root, 'src', 'gone.ts'), 'bye\n');

    const tool = new ApplyPatchTool();
    const result = await tool.execute(
      {
        patch: `*** Begin Patch
*** Add File: src/added.ts
+const k = 1;
*** Delete File: src/gone.ts
*** End Patch`,
      },
      root,
    );

    expect(result.error).toBeFalsy();
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(2);
    const added = diffs.find((d) => d.path.endsWith('added.ts'));
    const deleted = diffs.find((d) => d.path.endsWith('gone.ts'));
    expect(added?.added).toBe(1);
    expect(deleted?.removed).toBe(1);
    expect(readFileSync(join(root, 'src', 'added.ts'), 'utf-8')).toContain('const k = 1;');
  });

  it('publishes no diff for the file whose operation failed', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'const k = 1;\n');

    const tool = new ApplyPatchTool();
    const result = await tool.execute(
      {
        patch: `*** Begin Patch
*** Update File: src/ok.ts
@@
-const k = 1;
+const k = 2;
*** Update File: src/missing.ts
@@
-nope
+yes
*** End Patch`,
      },
      root,
    );

    expect(result.metadata?.patchStatus).toBe('partial');
    const diffs = diffsOf(result);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path.endsWith('ok.ts')).toBe(true);
  });
});
