import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../EditTool.js';
import { recordFileRead, clearFileReadState } from '../../file-read-state.js';

let root: string;
let outside: string;

/**
 * Simulate a prior read of the file so these unit tests exercise the edit
 * mechanics (matching, diffs) rather than the read-state gate, which has
 * its own coverage in tests/unit/tools/fileReadState.test.ts.
 */
function markAsRead(path: string): void {
  const s = statSync(path);
  recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size });
}

beforeEach(() => {
  clearFileReadState();
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
    markAsRead(join(root, 'memory', 'a.md'));
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'a.md'), 'utf-8')).toContain('TWO');
  });

  it('errors when old_string is not found', async () => {
    const tool = new EditTool();
    markAsRead(join(root, 'memory', 'a.md'));
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
    markAsRead(join(root, 'memory', 'a.md'));
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
    markAsRead(join(outside, 'o.md'));
    const result = await tool.execute(
      { file_path: join(outside, 'o.md'), old_string: 'outside', new_string: 'OUT' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(outside, 'o.md'), 'utf-8')).toContain('OUT');
  });
});

describe('EditTool diagnostics (P0-1)', () => {
  it('reports the closest line and divergence when old_string is absent', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'diag.md'), 'alpha\nbeta gamma\nomega\n');
    markAsRead(join(root, 'diag.md'));
    const result = await tool.execute(
      { file_path: join(root, 'diag.md'), old_string: 'beta GAMMA', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('Closest match: line 2');
    expect(result.result).toContain('divergence');
    expect(result.result).toContain('apply_patch');
  });

  it('flags CRLF line endings in the diagnostic', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'crlf.md'), 'a\r\nb\r\nc\r\n');
    markAsRead(join(root, 'crlf.md'));
    const result = await tool.execute(
      { file_path: join(root, 'crlf.md'), old_string: 'zzz', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('CRLF');
  });

  it('tells the model the file content is a truncated prefix of old_string', async () => {
    const tool = new EditTool();
    // file line "betaXYZ" is a strict prefix of the sought old_string
    // "betaXYZ more" -> the file ends first, so the diagnostic must say the
    // file content is truncated and advise a re-read.
    writeFileSync(join(root, 'prefix-file.md'), 'betaXYZ\n');
    markAsRead(join(root, 'prefix-file.md'));
    const result = await tool.execute(
      { file_path: join(root, 'prefix-file.md'), old_string: 'betaXYZ more', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('File content is a PREFIX of old_string');
    expect(result.result).toContain('Re-read the file');
  });

  it('tells the model the old_string is a truncated prefix of the file', async () => {
    const tool = new EditTool();
    // old_string "betaXYZ" is a strict prefix of the file line "betaXYZ more"
    // -> old_string ends first, so the diagnostic must flag an incomplete
    // old_string (likely cut off by compaction).
    writeFileSync(join(root, 'prefix-old.md'), 'betaXYZ more\n');
    markAsRead(join(root, 'prefix-old.md'));
    const result = await tool.execute(
      { file_path: join(root, 'prefix-old.md'), old_string: 'betaXYZ', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('old_string is a PREFIX of the file content');
    expect(result.result).toMatch(/re-read the file/i);
  });

  it('reports all occurrences when old_string is ambiguous', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'multi.md'), 'same\nother\nsame\n');
    markAsRead(join(root, 'multi.md'));
    const result = await tool.execute(
      { file_path: join(root, 'multi.md'), old_string: 'same', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('appears 2 times');
    expect(result.result).toContain('lines');
  });
});

describe('EditTool tolerant fallback (P1-4)', () => {
  it('matches after stripping trailing whitespace from old_string lines', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'ws.md'), 'const a = 1;\nconst b = 2;   \nconst c = 3;\n');
    markAsRead(join(root, 'ws.md'));
    // old_string has NO trailing space on line 2, file line does.
    const result = await tool.execute(
      { file_path: join(root, 'ws.md'), old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;', new_string: 'const a = 1;\nconst b = 99;\nconst c = 3;' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'ws.md'), 'utf-8')).toContain('const b = 99;');
  });

  it('matches after Unicode normalization (smart quotes, dashes, spaces)', async () => {
    const tool = new EditTool();
    // File uses smart quotes / em-dash; old_string uses ASCII equivalents.
    // Exact and whitespace-stripped matching fail; only the Unicode-normalized
    // fallback can match.
    writeFileSync(join(root, 'uni.md'), 'const label = \u201chello \u2014 world\u201d;\nconsole.log(label);\n');
    markAsRead(join(root, 'uni.md'));
    const result = await tool.execute(
      { file_path: join(root, 'uni.md'), old_string: 'const label = "hello - world";', new_string: 'const label = "ha - world";' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'uni.md'), 'utf-8')).toContain('const label = "ha - world";');
    expect(result.result).toContain('matched after Unicode normalization');
  });

  it('preserves CRLF and BOM on write', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'bom.md'), '\uFEFFa\r\nb\r\nc\r\n');
    markAsRead(join(root, 'bom.md'));
    const result = await tool.execute(
      { file_path: join(root, 'bom.md'), old_string: 'b', new_string: 'B' },
      root,
    );
    expect(result.error).toBeFalsy();
    const out = readFileSync(join(root, 'bom.md'), 'utf-8');
    expect(out).toBe('\uFEFFa\r\nB\r\nc\r\n');
  });
});

describe('EditTool multi-edit (edits[])', () => {
  it('applies multiple disjoint edits in one call', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'multi.md'), 'aaa\nbbb\nccc\nddd\n');
    markAsRead(join(root, 'multi.md'));
    const result = await tool.execute(
      {
        file_path: join(root, 'multi.md'),
        edits: [
          { old_string: 'aaa', new_string: 'A1' },
          { old_string: 'ccc', new_string: 'C3' },
        ],
      },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'multi.md'), 'utf-8')).toBe('A1\nbbb\nC3\nddd\n');
    expect(result.result).toContain('2 blocks changed');
    // Diff + first changed line are surfaced to the model.
    expect(result.result).toContain('First changed line: 1');
    expect(result.result).toContain('-1 aaa');
    expect(result.result).toContain('+1 A1');
  });

  it('matches each edit against the original file, not incrementally', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'inc.md'), 'x\nfoo\ny\n');
    markAsRead(join(root, 'inc.md'));
    // Both edits target the ORIGINAL content; the second would not exist if
    // edits were applied incrementally and renamed the first block.
    const result = await tool.execute(
      {
        file_path: join(root, 'inc.md'),
        edits: [
          { old_string: 'foo', new_string: 'FOO' },
          { old_string: 'x', new_string: 'X' },
        ],
      },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'inc.md'), 'utf-8')).toBe('X\nFOO\ny\n');
  });

  it('rejects overlapping edits', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'ov.md'), 'const a = 1;\nconst b = 2;\n');
    markAsRead(join(root, 'ov.md'));
    const result = await tool.execute(
      {
        file_path: join(root, 'ov.md'),
        edits: [
          { old_string: 'const a = 1;\nconst b = 2;', new_string: 'let both;' },
          { old_string: 'const b = 2;', new_string: 'let b = 2;' },
        ],
      },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('overlap');
    expect(readFileSync(join(root, 'ov.md'), 'utf-8')).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('reports which edits[i] is missing with a diagnostic', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'miss.md'), 'aaa\nbbb\n');
    markAsRead(join(root, 'miss.md'));
    const result = await tool.execute(
      {
        file_path: join(root, 'miss.md'),
        edits: [
          { old_string: 'aaa', new_string: 'A' },
          { old_string: 'zzz', new_string: 'Z' },
        ],
      },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('edits[1].old_string not found');
  });

  it('reports which edits[i] is ambiguous', async () => {
    const tool = new EditTool();
    writeFileSync(join(root, 'amb.md'), 'same\nother\nsame\n');
    markAsRead(join(root, 'amb.md'));
    const result = await tool.execute(
      {
        file_path: join(root, 'amb.md'),
        edits: [
          { old_string: 'other', new_string: 'x' },
          { old_string: 'same', new_string: 'y' },
        ],
      },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('edits[1].old_string appears 2 times');
  });
});
