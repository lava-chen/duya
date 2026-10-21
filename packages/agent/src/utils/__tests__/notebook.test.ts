/**
 * notebook.ts unit tests
 *
 * The notebook reader had no direct unit test before 86f68e9e removed it
 * (only the ReadTool snapshot test covered it), which is how a removal
 * scoped to the document-parser service went unnoticed while the read path
 * kept advertising the feature. These tests pin the module's contract
 * directly: cell-range semantics, the normalized cell model, the
 * model-facing serialization, and the error surface for malformed input.
 */

import { describe, it, expect } from 'vitest';
import {
  parseNotebookJson,
  serializeNotebookForModel,
  serializeCellForModel,
  validateCellRange,
  truncateOutputText,
  summarizeNotebook,
  NotebookParseError,
  UnsupportedNbformatError,
  NotebookCellRangeError,
} from '../notebook.js';

function nb(cells: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells, ...extra });
}

const CODE = (source: string, outputs: unknown[] = [], execution_count: number | null = 1) => ({
  cell_type: 'code',
  source,
  outputs,
  execution_count,
});

describe('parseNotebookJson: cell model', () => {
  it('joins an array-form source into one string', () => {
    const result = parseNotebookJson(
      nb([{ cell_type: 'markdown', source: ['# Title\n', 'body'] }]),
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.source).toBe('# Title\nbody');
    expect(result.cells[0]!.cellType).toBe('markdown');
  });

  it('falls back to cell-N for a cell with no id, and keeps an explicit id', () => {
    const result = parseNotebookJson(
      nb([CODE('a=1'), { cell_type: 'code', id: 'named', source: 'b=2' }]),
    );
    expect(result.cells.map((c) => c.cellId)).toEqual(['cell-1', 'named']);
  });

  it('treats an unknown cell_type as raw', () => {
    const result = parseNotebookJson(nb([{ cell_type: 'mystery', source: 'x' }]));
    expect(result.cells[0]!.cellType).toBe('raw');
  });

  it('reads the kernel language, preferring language_info over kernelspec', () => {
    expect(
      parseNotebookJson(nb([], { metadata: { language_info: { name: 'python' } } })).language,
    ).toBe('python');
    expect(
      parseNotebookJson(nb([], { metadata: { kernelspec: { language: 'julia' } } })).language,
    ).toBe('julia');
    expect(parseNotebookJson(nb([])).language).toBe('python');
  });

  it('records a missing cells array as an empty notebook', () => {
    const result = parseNotebookJson(JSON.stringify({ nbformat: 4 }));
    expect(result.cells).toEqual([]);
    expect(result.totalCellCount).toBe(0);
  });
});

describe('parseNotebookJson: cell_range', () => {
  const three = () => nb([CODE('a=1'), CODE('b=2'), CODE('c=3')]);

  it('slices a 1-based inclusive range', () => {
    const result = parseNotebookJson(three(), { cellRange: { start: 2, end: 3 } });
    expect(result.cells.map((c) => c.source)).toEqual(['b=2', 'c=3']);
    // Ids stay numbered against the whole notebook, not the slice.
    expect(result.cells.map((c) => c.cellId)).toEqual(['cell-2', 'cell-3']);
    expect(result.cells.map((c) => c.index)).toEqual([1, 2]);
    expect(result.totalCellCount).toBe(3);
  });

  it('treats end=-1 as "to end of notebook"', () => {
    const result = parseNotebookJson(three(), { cellRange: { start: 2, end: -1 } });
    expect(result.cells.map((c) => c.source)).toEqual(['b=2', 'c=3']);
  });

  it('clamps an end past the last cell instead of erroring', () => {
    const result = parseNotebookJson(three(), { cellRange: { start: 1, end: 99 } });
    expect(result.cells).toHaveLength(3);
  });

  it('rejects start past the last cell', () => {
    expect(() => parseNotebookJson(three(), { cellRange: { start: 4, end: -1 } })).toThrow(
      NotebookCellRangeError,
    );
    expect(() => parseNotebookJson(three(), { cellRange: { start: 4, end: -1 } })).toThrow(
      /exceeds notebook size \(3 cells\)/,
    );
  });

  it('rejects start < 1 and end < start', () => {
    expect(() => parseNotebookJson(three(), { cellRange: { start: 0, end: 1 } })).toThrow(
      /start \(0\) must be >= 1/,
    );
    expect(() => parseNotebookJson(three(), { cellRange: { start: 3, end: 1 } })).toThrow(
      /end \(1\) < start \(3\)/,
    );
  });

  it('validateCellRange accepts an empty notebook only for a range it rejects', () => {
    expect(() => validateCellRange({ start: 1, end: 1 }, 0)).toThrow(NotebookCellRangeError);
  });
});

describe('parseNotebookJson: malformed input', () => {
  it('rejects content that is not valid JSON', () => {
    expect(() => parseNotebookJson('{ "cells": [ oops')).toThrow(NotebookParseError);
    expect(() => parseNotebookJson('{ "cells": [ oops')).toThrow(/invalid notebook JSON/);
  });

  it('rejects valid JSON that is not a notebook object', () => {
    for (const bad of ['[]', '"a string"', '42', 'null', 'true']) {
      expect(() => parseNotebookJson(bad)).toThrow(UnsupportedNbformatError);
    }
  });

  it('rejects an object with no nbformat, naming the version it saw', () => {
    expect(() => parseNotebookJson('{"hello":"world"}')).toThrow(/unsupported nbformat version 0/);
  });

  it('rejects a future nbformat', () => {
    expect(() => parseNotebookJson('{"nbformat":99,"cells":[]}')).toThrow(
      /unsupported nbformat version 99/,
    );
  });

  it('accepts nbformat 3 and 4', () => {
    expect(parseNotebookJson('{"nbformat":3,"cells":[]}').nbformat).toBe(3);
    expect(parseNotebookJson('{"nbformat":4,"cells":[]}').nbformat).toBe(4);
  });

  it('rejects a cells entry that is not a cell object', () => {
    // Would otherwise serialize to a cell whose source is `undefined`.
    expect(() => parseNotebookJson('{"nbformat":4,"cells":["oops"]}')).toThrow(
      /cell 1 is not a cell object \(got a string\)/,
    );
    expect(() => parseNotebookJson('{"nbformat":4,"cells":[null]}')).toThrow(
      /cell 1 is not a cell object \(got null\)/,
    );
    expect(() => parseNotebookJson('{"nbformat":4,"cells":[[1]]}')).toThrow(
      /cell 1 is not a cell object \(got an array\)/,
    );
  });

  it('rejects a cell with no readable source', () => {
    expect(() => parseNotebookJson('{"nbformat":4,"cells":[{"cell_type":"code"}]}')).toThrow(
      /cell 1 has no readable `source` \(got nothing\)/,
    );
  });

  it('names the offending cell index', () => {
    expect(() =>
      parseNotebookJson(
        '{"nbformat":4,"cells":[{"cell_type":"code","source":"ok"},"bad"]}',
      ),
    ).toThrow(/cell 2 is not a cell object/);
  });
});

describe('parseNotebookJson: outputs', () => {
  it('joins stream text arrays and counts their bytes', () => {
    const result = parseNotebookJson(nb([CODE('x', [{ output_type: 'stream', text: ['a', 'b'] }])]));
    expect(result.cells[0]!.outputs).toEqual([{ type: 'stream', text: 'ab' }]);
    expect(result.totalOutputBytes).toBe(2);
  });

  it('reads text/plain out of a data bundle', () => {
    const result = parseNotebookJson(
      nb([CODE('x', [{ output_type: 'execute_result', data: { 'text/plain': '42' } }])]),
    );
    expect(result.cells[0]!.outputs).toEqual([
      { type: 'execute_result', text: '42', hasImage: false },
    ]);
  });

  it('flags an image output rather than dropping it silently', () => {
    const result = parseNotebookJson(
      nb([
        CODE('plot()', [
          { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } },
        ]),
      ]),
    );
    expect(result.cells[0]!.outputs).toEqual([
      { type: 'display_data', text: undefined, hasImage: true },
    ]);
    expect(result.imageOutputCount).toBe(1);
    // The cell still says it produced an output.
    expect(serializeCellForModel(result.cells[0]!)).toContain('image output present');
  });

  it('composes an error output from ename/evalue/traceback', () => {
    const result = parseNotebookJson(
      nb([
        CODE('boom', [
          { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['l1', 'l2'] },
        ]),
      ]),
    );
    expect(result.cells[0]!.outputs).toEqual([
      { type: 'error', text: 'ValueError: bad\nl1\nl2' },
    ]);
  });

  it('truncates a single oversized output at 10KB', () => {
    const result = parseNotebookJson(
      nb([CODE('x', [{ output_type: 'stream', text: 'y'.repeat(30_000) }])]),
    );
    const output = result.cells[0]!.outputs![0]!;
    expect(output.text.length).toBeLessThan(11_000);
    expect(output.text).toContain('[Output truncated at 10KB');
  });

  it('leaves a short output untouched', () => {
    expect(truncateOutputText('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('model-facing serialization', () => {
  it('formats a markdown cell with no metadata prefix', () => {
    const result = parseNotebookJson(nb([{ cell_type: 'markdown', source: '# Title' }]));
    expect(serializeCellForModel(result.cells[0]!)).toBe(
      '<cell id="cell-1"># Title</cell id="cell-1">',
    );
  });

  it('puts language before execution_count and appends outputs', () => {
    const result = parseNotebookJson(
      nb([CODE('print("hi")', [{ output_type: 'stream', text: 'hi' }], 1)]),
    );
    expect(serializeCellForModel(result.cells[0]!)).toBe(
      '<cell id="cell-1"><language>python</language><execution_count>1</execution_count>' +
        'print("hi")\n\nOutput:\nhi</cell id="cell-1">',
    );
  });

  it('omits execution_count for an unexecuted code cell', () => {
    const result = parseNotebookJson(nb([CODE('x', [], null)]));
    expect(serializeCellForModel(result.cells[0]!)).not.toContain('execution_count');
  });

  it('summarizes the cells it was given, not the whole notebook', () => {
    const all = parseNotebookJson(
      nb([
        { cell_type: 'markdown', source: '# T' },
        CODE('a', [], 1),
        CODE('b', [{ output_type: 'error', ename: 'E', evalue: 'v' }], 2),
        CODE('c', [], null),
        { cell_type: 'raw', source: 'r' },
      ]),
    );
    expect(summarizeNotebook(all)).toBe(
      '5 cells, kernel=python, 3 code (2 executed, 1 error, 1 unexecuted), 1 markdown, 1 raw, 0.0MB outputs, nbformat 4.5',
    );

    // A cell_range read describes only the cells it returned, so the
    // summary and the body can never disagree.
    const ranged = parseNotebookJson(
      nb([
        { cell_type: 'markdown', source: '# T' },
        CODE('a', [], 1),
        CODE('b', [], 2),
      ]),
      { cellRange: { start: 2, end: 3 } },
    );
    expect(summarizeNotebook(ranged)).toBe(
      '2 cells, kernel=python, 2 code (2 executed, 0 error, 0 unexecuted), 0 markdown, 0 raw, 0.0MB outputs, nbformat 4.5',
    );
  });

  it('joins the bracketed summary and the cells into one body', () => {
    const result = parseNotebookJson(nb([CODE('a=1'), CODE('b=2')]));
    const serialized = serializeNotebookForModel(result);
    expect(serialized.summary).toBe('[2 cells, kernel=python, 2 code (2 executed, 0 error, 0 unexecuted), 0 markdown, 0 raw, 0.0MB outputs, nbformat 4.5]');
    expect(serialized.cells).toHaveLength(2);
    expect(serialized.body.split('\n\n')).toHaveLength(3);
    expect(serialized.body.startsWith('[2 cells,')).toBe(true);
  });
});
