import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotebookParser } from '../../../../src/file-parser/parsers/notebook.js';

const NB = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'code', id: 'a', source: 'x = 1', outputs: [], execution_count: 1 },
    { cell_type: 'markdown', source: '# hi' },
    { cell_type: 'code', id: 'c', source: 'print(2)', outputs: [{ output_type: 'stream', text: '2' }], execution_count: 2 },
  ],
};

function writeNotebook(content: object = NB): string {
  const dir = mkdtempSync(join(tmpdir(), 'nb-parser-'));
  const path = join(dir, 'foo.ipynb');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('NotebookParser', () => {
  it('emits a summary header chunk + one chunk per cell', async () => {
    const path = writeNotebook();
    try {
      const parser = new NotebookParser();
      const result = await parser.parse(path);
      expect(result.extractMethod).toBe('hybrid');
      // header + 3 cells
      expect(result.chunks).toHaveLength(4);
      expect(result.chunks[0]?.text).toContain('3 cells');
      expect(result.chunks[0]?.text).toContain('kernel=python');
      expect(result.chunks[1]?.text).toContain('<cell id="a">');
      expect(result.chunks[1]?.text).toContain('<language>python</language>');
      expect(result.chunks[2]?.text).toContain('<cell id="cell-2">');
      expect(result.chunks[3]?.text).toContain('<cell id="c">');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('extracts image outputs into RawParse.images', async () => {
    const path = writeNotebook({
      nbformat: 4,
      metadata: { language_info: { name: 'python' } },
      cells: [
        {
          cell_type: 'code',
          source: 'plt.show()',
          execution_count: 1,
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'image/png':
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
              },
            },
          ],
        },
      ],
    });
    try {
      const parser = new NotebookParser();
      const result = await parser.parse(path);
      expect(result.images).toBeDefined();
      expect(result.images).toHaveLength(1);
      expect(result.images?.[0]?.mediaType).toBe('image/png');
      expect(result.images?.[0]?.base64.length).toBeGreaterThan(0);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
});
