import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readNotebook,
  NotebookParseError,
  UnsupportedNbformatError,
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
