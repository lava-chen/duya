/**
 * markdown-table-export.ts - Pure table-text builders behind the chat
 * markdown table toolbar (copy as Markdown / download as CSV), mirroring
 * ZCode's markdown-table actions.
 */

export type MarkdownTableRows = string[][];

function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeCsvCell(value: string): string {
  // CSV opened in Excel/Numbers/LibreOffice interprets formula prefixes
  // (=, +, -, @) as formulas; neutralize them with a leading apostrophe.
  const safeValue =
    /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

/** Reads normalized cell text from a rendered table element (header row first). */
export function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ''),
      ),
    )
    .filter((row) => row.length > 0);
}

/** Rebuilds a GitHub-flavored markdown table; ragged rows are padded to the widest one. */
export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? '')),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => '---');
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

/** Builds CSV text with a UTF-8 BOM so Excel decodes CJK cells correctly. */
export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\r\n');
  return `\uFEFF${csv}`;
}
