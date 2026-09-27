/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import {
  buildCsvTableText,
  buildMarkdownTableText,
  readRowsFromTable,
} from './markdown-table-export';

function makeTable(rows: string[][]): HTMLTableElement {
  const table = document.createElement('table');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  document.body.appendChild(table);
  return table;
}

describe('markdown-table-export', () => {
  it('rebuilds a markdown table with a separator row', () => {
    const text = buildMarkdownTableText([
      ['name', 'value'],
      ['alpha', '1'],
      ['beta', '2'],
    ]);
    expect(text).toBe(
      ['| name | value |', '| --- | --- |', '| alpha | 1 |', '| beta | 2 |'].join('\n'),
    );
  });

  it('escapes pipes and newlines, and pads ragged rows', () => {
    const text = buildMarkdownTableText([['a', 'b'], ['x|y', 'line1\nline2']]);
    expect(text).toContain('x\\|y');
    expect(text).toContain('line1<br>line2');
    // Ragged first row is padded to the widest row length.
    expect(text.split('\n')[0]).toBe('| a | b |');
    expect(text.split('\n')[1]).toBe('| --- | --- |');
  });

  it('returns empty markdown for an empty table', () => {
    expect(buildMarkdownTableText([])).toBe('');
  });

  it('builds CSV with a UTF-8 BOM and CRLF rows', () => {
    const csv = buildCsvTableText([
      ['name', '备注'],
      ['alpha', '两行\n单元格'],
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('name,备注');
    expect(csv).toContain('"两行\n单元格"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('neutralizes formula prefixes in CSV cells', () => {
    const csv = buildCsvTableText([['=cmd()', '+1', '@x', '-2', 'plain', ' =ok']]);
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@x");
    expect(csv).toContain("'-2");
    expect(csv).toContain('plain');
    // Indented prefix stays guarded; a formula char past leading whitespace
    // would not be interpreted by spreadsheet apps and is left alone.
    expect(csv).toContain("' =ok");
  });

  it('doubles embedded quotes in CSV cells', () => {
    const csv = buildCsvTableText([['say "hi"']]);
    expect(csv).toBe('\uFEFF"say ""hi"""');
  });

  it('reads normalized rows from a rendered table', () => {
    const table = makeTable([
      [' name ', 'value'],
      ['alpha', '1'],
    ]);
    try {
      expect(readRowsFromTable(table)).toEqual([
        ['name', 'value'],
        ['alpha', '1'],
      ]);
      expect(readRowsFromTable(null)).toEqual([]);
    } finally {
      table.remove();
    }
  });

  it('squashes internal whitespace when reading cells', () => {
    const table = document.createElement('table');
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = 'a\n  b\tc';
    tr.appendChild(td);
    table.appendChild(tr);
    expect(readRowsFromTable(table)).toEqual([['a b c']]);
  });
});
