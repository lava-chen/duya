import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNotebookJson,
  summarizeNotebook,
  validateCellRange,
  extractOutputImage,
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

describe('parseNotebookJson', () => {
  it('parses a valid v4 notebook with mixed cell types', () => {
    const result = parseNotebookJson(JSON.stringify(VALID_V4));
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]?.cellId).toBe('abc-123');
    expect(result.cells[0]?.cellType).toBe('code');
    expect(result.cells[1]?.cellId).toBe('cell-2');
    expect(result.cells[1]?.cellType).toBe('markdown');
    expect(result.cells[1]?.source).toBe('# Hello\nworld');
    expect(result.language).toBe('python');
  });

  it('throws NotebookParseError on malformed JSON', () => {
    expect(() => parseNotebookJson('{ not valid json')).toThrow(NotebookParseError);
  });

  it('throws UnsupportedNbformatError on nbformat 2', () => {
    expect(() => parseNotebookJson(JSON.stringify({ nbformat: 2, cells: [] }))).toThrow(
      UnsupportedNbformatError,
    );
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

describe('extractOutputImage', () => {
  it('decodes image/png from data and writes to sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notebook-sidecar-'));
    const sidecar = join(dir, 'cells');
    try {
      // 1x1 transparent PNG
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const data = { 'image/png': png };
      const result = await extractOutputImage(data, 0, 0, sidecar);
      expect(result).toBeDefined();
      expect(result?.mediaType).toBe('image/png');
      expect(result?.imagePath).toBe(join(sidecar, 'cell-0-0.png'));
      expect(existsSync(result!.imagePath)).toBe(true);
      const written = readFileSync(result!.imagePath);
      expect(written.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no image data present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notebook-sidecar-'));
    const sidecar = join(dir, 'cells');
    try {
      expect(await extractOutputImage({ 'text/plain': 'hi' }, 0, 0, sidecar)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips whitespace from base64 before writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notebook-sidecar-'));
    const sidecar = join(dir, 'cells');
    try {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const data = { 'image/png': `  ${png.slice(0, 10)}\n${png.slice(10)}  ` };
      const result = await extractOutputImage(data, 0, 0, sidecar);
      expect(result?.imagePath).toBe(join(sidecar, 'cell-0-0.png'));
      expect(readFileSync(result!.imagePath).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined and does not throw when sidecar dir is unwritable', async () => {
    // Use a path under a file (not a dir) to force mkdir failure
    const dir = mkdtempSync(join(tmpdir(), 'notebook-sidecar-fail-'));
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    try {
      const result = await extractOutputImage(
        { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' },
        0,
        0,
        join(blocker, 'cells'), // can't mkdir under a file
      );
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
