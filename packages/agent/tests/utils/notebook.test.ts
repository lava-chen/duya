import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readNotebook,
  summarizeNotebook,
  validateCellRange,
  NotebookParseError,
  UnsupportedNbformatError,
  NotebookCellRangeError,
} from '../../src/utils/notebook.js';

const VALID_V4 = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', language: 'python' } },
  cells: [
    { cell_type: 'code', id: 'abc-123', source: 'print(1)', outputs: [], execution_count: 1 },
    { cell_type: 'markdown', source: ['# Hello\n', 'world'] },
  ],
};

function writeTempNotebook(content: string | object): string {
  const dir = mkdtempSync(join(tmpdir(), 'notebook-test-'));
  const path = join(dir, 'sample.ipynb');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('readNotebook', () => {
  it('parses a valid v4 notebook with mixed cell types', async () => {
    const path = writeTempNotebook(VALID_V4);
    try {
      const result = await readNotebook(path);
      expect(result.cells).toHaveLength(2);
      expect(result.cells[0]?.cellId).toBe('abc-123');
      expect(result.cells[0]?.cellType).toBe('code');
      expect(result.cells[1]?.cellId).toBe('cell-2');
      expect(result.cells[1]?.cellType).toBe('markdown');
      expect(result.cells[1]?.source).toBe('# Hello\nworld');
      expect(result.language).toBe('python');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('throws NotebookParseError on malformed JSON', async () => {
    const path = writeTempNotebook('{ not valid json');
    try {
      await expect(readNotebook(path)).rejects.toThrow(NotebookParseError);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('throws UnsupportedNbformatError on nbformat 2', async () => {
    const path = writeTempNotebook({ nbformat: 2, cells: [] });
    try {
      await expect(readNotebook(path)).rejects.toThrow(UnsupportedNbformatError);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
});

describe('summarizeNotebook', () => {
  it('produces a header line with cell counts and kernel', () => {
    const summary = summarizeNotebook({
      language: 'python',
      nbformat: 4,
      nbformatMinor: 5,
      totalOutputBytes: 8_200_000,
      cells: [
        { index: 0, cellId: 'cell-1', cellType: 'code', source: '', language: 'python', executionCount: 1, outputs: [] },
        { index: 1, cellId: 'cell-2', cellType: 'code', source: '', language: 'python', executionCount: 2, outputs: [] },
        { index: 2, cellId: 'cell-3', cellType: 'code', source: '', language: 'python', executionCount: null, outputs: [] },
        { index: 3, cellId: 'cell-4', cellType: 'code', source: '', language: 'python', outputs: [{ type: 'error', text: 'x' }] },
        { index: 4, cellId: 'cell-5', cellType: 'markdown', source: '' },
      ],
    });
    expect(summary).toContain('5 cells');
    expect(summary).toContain('kernel=python');
    expect(summary).toContain('4 code');
    expect(summary).toContain('1 markdown');
    expect(summary).toContain('2 executed');
    expect(summary).toContain('1 error');
    expect(summary).toContain('2 unexecuted');
  });
});

describe('validateCellRange', () => {
  it('accepts a valid in-bounds range', () => {
    expect(() => validateCellRange({ start: 1, end: 5 }, 10)).not.toThrow();
  });

  it('accepts end=-1 (sentinel)', () => {
    expect(() => validateCellRange({ start: 1, end: -1 }, 10)).not.toThrow();
  });

  it('rejects start > cellCount', () => {
    expect(() => validateCellRange({ start: 100, end: 110 }, 10)).toThrow(NotebookCellRangeError);
  });

  it('rejects end < start (non-sentinel)', () => {
    expect(() => validateCellRange({ start: 5, end: 2 }, 10)).toThrow(NotebookCellRangeError);
  });
});
