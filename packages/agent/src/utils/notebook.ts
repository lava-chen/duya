/**
 * notebook - Jupyter notebook (.ipynb) reading utilities
 *
 * Pure functions that turn a notebook's raw JSON into a normalized cell
 * model plus the model-facing text format the `read` tool returns.
 *
 * Recovered from 86f68e9e ("chore: remove document parser service and
 * Office panel"), which deleted this module as collateral damage to a
 * change scoped to the document-parser service. The parsing, cell-range
 * and serialization logic below is the original implementation. Two
 * things changed on the way back:
 *
 *   - The sidecar image extraction is gone. It wrote a `<notebook>.cells/`
 *     directory next to the user's notebook for a `RawParse.images`
 *     consumer (the deleted result-builder) that no longer exists, so
 *     restoring it would create stray files in the user's workspace to
 *     feed a path that is not there. Image outputs are recorded with
 *     `hasImage` instead, so a cell holding a plot does not read as if it
 *     produced no output at all.
 *   - `serializeCellForModel` moved here from the deleted
 *     `file-parser/parsers/notebook.ts`, so this module is self-contained
 *     and needs no parser registry, worker pool or document-parser service.
 *
 * Semantics worth keeping straight:
 *   - cellId is 1-based (`cell-${index + 1}`) to match duya's 1-based
 *     cell_range and line_range semantics
 *   - a cell's `index` is its position in the WHOLE notebook, not in the
 *     sliced view, so cell ids stay stable under cell_range
 *   - per-output 10KB cap is local (duya has no shared formatOutput)
 */

// ============================================================
// Errors
// ============================================================

export class NotebookParseError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NotebookParseError';
    this.cause = cause;
  }
}

export class UnsupportedNbformatError extends Error {
  readonly nbformat: number;

  constructor(nbformat: number) {
    super(
      `Cannot read notebook: unsupported nbformat version ${nbformat} (only 3 and 4 supported). ` +
        'The file may not be a Jupyter notebook, or it may be a future format this reader does not understand.',
    );
    this.name = 'UnsupportedNbformatError';
    this.nbformat = nbformat;
  }
}

export class NotebookCellRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookCellRangeError';
  }
}

// ============================================================
// Public types
// ============================================================

export type CellType = 'code' | 'markdown' | 'raw';

export type NotebookOutput =
  | { type: 'stream'; text: string }
  | { type: 'execute_result'; text?: string; hasImage: boolean }
  | { type: 'display_data'; text?: string; hasImage: boolean }
  | { type: 'error'; text: string };

export interface ProcessedCell {
  /** 0-based position in the whole notebook, not in a cell_range slice */
  index: number;
  /** cell.id if present, else `cell-${index + 1}` (1-based) */
  cellId: string;
  cellType: CellType;
  /** source joined into a single string */
  source: string;
  /** code cells only */
  language?: string;
  /** code cells only; null/undefined preserved */
  executionCount?: number;
  /** code cells only */
  outputs?: NotebookOutput[];
}

export interface ReadNotebookResult {
  /** The cells in the requested (or default) range */
  cells: ProcessedCell[];
  /** Cell count of the whole notebook, before any cell_range slice */
  totalCellCount: number;
  language: string;
  /** Original nbformat 3 or 4, for summary header */
  nbformat: number;
  nbformatMinor: number;
  /** Sum of output text bytes - for summary header */
  totalOutputBytes: number;
  /** How many outputs carried an image that this reader does not inline */
  imageOutputCount: number;
}

// ============================================================
// Raw nbformat shapes (subset)
// ============================================================

interface RawCell {
  cell_type: string;
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: RawOutput[];
  execution_count?: number | null;
}

interface RawOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[] | number | boolean | null>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  name?: string;
}

interface RawNotebook {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    kernelspec?: { name?: string; language?: string };
    language_info?: { name?: string };
  };
  cells?: RawCell[];
}

// ============================================================
// parseNotebookJson
// ============================================================

const SUPPORTED_NBFORMATS = new Set([3, 4]);

export interface ParseNotebookOptions {
  /** 1-based inclusive cell range. `end: -1` means "to end of notebook". */
  cellRange?: { start: number; end: number };
}

/**
 * Pure function: parse raw notebook JSON content into processed cells.
 *
 * Throws NotebookParseError when the content is not valid JSON,
 * UnsupportedNbformatError when it is valid JSON but not a notebook this
 * reader understands, and NotebookCellRangeError when `cellRange` does not
 * fit the notebook. Every one of those messages is written for the model,
 * so a caller can surface `err.message` directly.
 */
export function parseNotebookJson(
  content: string,
  options: ParseNotebookOptions = {},
): ReadNotebookResult {
  let notebook: RawNotebook;
  try {
    notebook = JSON.parse(content) as RawNotebook;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new NotebookParseError(
      `Cannot read notebook: invalid notebook JSON: ${reason}`,
      err,
    );
  }

  if (notebook === null || typeof notebook !== 'object' || Array.isArray(notebook)) {
    throw new UnsupportedNbformatError(0);
  }

  const nbformat = notebook.nbformat ?? 0;
  if (!SUPPORTED_NBFORMATS.has(nbformat)) {
    throw new UnsupportedNbformatError(nbformat);
  }

  const language =
    notebook.metadata?.language_info?.name ??
    notebook.metadata?.kernelspec?.language ??
    'python';

  const allCells = Array.isArray(notebook.cells) ? notebook.cells : [];
  // A cells entry that is not an object would otherwise read as a cell
  // with an undefined source and serialize to `undefined` in the output —
  // a silent garbage read. Refuse the file instead.
  allCells.forEach((cell, i) => {
    if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
      throw new NotebookParseError(
        `Cannot read notebook: cell ${i + 1} is not a cell object (got ${describeShape(cell)}).`,
      );
    }
    if (typeof cell.source !== 'string' && !Array.isArray(cell.source)) {
      throw new NotebookParseError(
        `Cannot read notebook: cell ${i + 1} has no readable \`source\` (got ${describeShape(cell.source)}).`,
      );
    }
  });
  if (options.cellRange) {
    validateCellRange(options.cellRange, allCells.length);
  }

  const startIdx = options.cellRange ? options.cellRange.start - 1 : 0;
  const endIdx =
    options.cellRange && options.cellRange.end !== -1
      ? Math.min(options.cellRange.end, allCells.length)
      : allCells.length;
  const slice = allCells.slice(startIdx, endIdx);

  const cells: ProcessedCell[] = slice.map((rawCell, i) =>
    processCell(rawCell, startIdx + i, language),
  );

  let totalOutputBytes = 0;
  let imageOutputCount = 0;
  for (const cell of cells) {
    for (const output of cell.outputs ?? []) {
      if (output.type === 'stream' || output.type === 'error') {
        totalOutputBytes += output.text.length;
      } else {
        if (output.text) totalOutputBytes += output.text.length;
        if (output.hasImage) imageOutputCount += 1;
      }
    }
  }

  return {
    cells,
    totalCellCount: allCells.length,
    language,
    nbformat,
    nbformatMinor: notebook.nbformat_minor ?? 0,
    totalOutputBytes,
    imageOutputCount,
  };
}

// ============================================================
// Internal helpers (exported for tests)
// ============================================================

export function processCell(
  raw: RawCell,
  index: number,
  language: string,
): ProcessedCell {
  const cellId = raw.id ?? `cell-${index + 1}`;
  const cellType: CellType =
    raw.cell_type === 'code' || raw.cell_type === 'markdown' || raw.cell_type === 'raw'
      ? raw.cell_type
      : 'raw';
  const source = Array.isArray(raw.source) ? raw.source.join('') : raw.source;

  const cell: ProcessedCell = {
    index,
    cellId,
    cellType,
    source,
  };

  if (cellType === 'code') {
    cell.language = language;
    if (raw.execution_count != null) {
      cell.executionCount = raw.execution_count;
    }
    if (raw.outputs && raw.outputs.length > 0) {
      cell.outputs = raw.outputs.map(processOutput);
    }
  }

  return cell;
}

export function processOutput(raw: RawOutput): NotebookOutput {
  switch (raw.output_type) {
    case 'stream': {
      const text = Array.isArray(raw.text) ? raw.text.join('') : raw.text ?? '';
      return { type: 'stream', text: truncateOutputText(text).text };
    }
    case 'execute_result':
    case 'display_data': {
      const text = extractTextFromData(raw.data);
      return {
        type: raw.output_type,
        text: text ? truncateOutputText(text).text : undefined,
        // Image payloads are deliberately not decoded or inlined. Record
        // that one was present so the cell still reports an output.
        hasImage: hasImageData(raw.data),
      };
    }
    case 'error': {
      const ename = raw.ename ?? '';
      const evalue = raw.evalue ?? '';
      const traceback = (raw.traceback ?? []).join('\n');
      const composed = `${ename}: ${evalue}\n${traceback}`;
      return { type: 'error', text: truncateOutputText(composed).text };
    }
    default:
      return { type: 'stream', text: '' };
  }
}

/** Short human-readable type name, for a malformed-input message. */
function describeShape(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function extractTextFromData(data: RawOutput['data']): string {
  if (!data) return '';
  const textPlain = data['text/plain'];
  if (typeof textPlain === 'string') return textPlain;
  if (Array.isArray(textPlain)) return textPlain.join('');
  return '';
}

function hasImageData(data: RawOutput['data']): boolean {
  if (!data) return false;
  return 'image/png' in data || 'image/jpeg' in data;
}

export function validateCellRange(
  range: { start: number; end: number },
  cellCount: number,
): void {
  if (range.start < 1) {
    throw new NotebookCellRangeError(
      `cell_range invalid: start (${range.start}) must be >= 1`,
    );
  }
  if (range.end !== -1 && range.end < range.start) {
    throw new NotebookCellRangeError(
      `cell_range invalid: end (${range.end}) < start (${range.start})`,
    );
  }
  if (range.start > cellCount) {
    throw new NotebookCellRangeError(
      `cell_range {start:${range.start}, end:${range.end}} exceeds notebook size (${cellCount} cells)`,
    );
  }
}

const OUTPUT_TEXT_CAP = 10_000;

export function truncateOutputText(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_TEXT_CAP) return { text, truncated: false };
  // Cut at nearest paragraph break within the budget
  const slice = text.slice(0, OUTPUT_TEXT_CAP);
  const paraBreak = slice.lastIndexOf('\n\n');
  const cut = paraBreak > OUTPUT_TEXT_CAP / 2 ? paraBreak : OUTPUT_TEXT_CAP;
  return {
    text: `${slice.slice(0, cut)}\n\n[Output truncated at 10KB. Use bash with: cat <notebook_path> | jq '.cells[N].outputs' to see full output.]`,
    truncated: true,
  };
}

export function summarizeNotebook(result: ReadNotebookResult): string {
  const codeCells = result.cells.filter((c) => c.cellType === 'code');
  const markdownCells = result.cells.filter((c) => c.cellType === 'markdown');
  const rawCells = result.cells.filter((c) => c.cellType === 'raw');

  const executed = codeCells.filter(
    (c) => c.executionCount !== undefined && c.executionCount !== null,
  );
  const errored = codeCells.filter(
    (c) => c.outputs?.some((o) => o.type === 'error') ?? false,
  );
  const unexecuted = codeCells.filter(
    (c) => c.executionCount === null || c.executionCount === undefined,
  );

  const outputMb = (result.totalOutputBytes / (1024 * 1024)).toFixed(1);
  return [
    `${result.cells.length} cells`,
    `kernel=${result.language}`,
    `${codeCells.length} code (${executed.length} executed, ${errored.length} error, ${unexecuted.length} unexecuted)`,
    `${markdownCells.length} markdown`,
    `${rawCells.length} raw`,
    `${outputMb}MB outputs`,
    `nbformat ${result.nbformat}.${result.nbformatMinor}`,
  ].join(', ');
}

// ============================================================
// Model-facing serialization
//
// The cell format mirrors Claude Code's:
//   <cell id="cell-3"><language>python</language>def foo(): pass</cell id="cell-3">
// ============================================================

/** Stand-in for an output image this text reader does not inline. */
const IMAGE_OUTPUT_MARKER = '[image output present but not included in this read]';

/** Serialize a single cell into the model-facing text format. */
export function serializeCellForModel(cell: ProcessedCell): string {
  const metadata: string[] = [];
  if (cell.cellType === 'code' && cell.language) {
    metadata.push(`<language>${cell.language}</language>`);
  }
  if (cell.cellType === 'code' && cell.executionCount != null) {
    metadata.push(`<execution_count>${cell.executionCount}</execution_count>`);
  }
  let body = cell.source;
  if (cell.cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
    const outputText = cell.outputs
      .map((o) => {
        if (o.type === 'stream' || o.type === 'error') return o.text;
        if (o.text) return o.text;
        return o.hasImage ? IMAGE_OUTPUT_MARKER : '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
    if (outputText) {
      body += `\n\nOutput:\n${outputText}`;
    }
  }
  return `<cell id="${cell.cellId}">${metadata.join('')}${body}</cell id="${cell.cellId}">`;
}

export interface SerializedNotebook {
  /** The bracketed summary line, e.g. `[3 cells, kernel=python, ...]` */
  summary: string;
  /** One serialized cell per entry, in notebook order */
  cells: string[];
  /** The summary plus the cells, joined for the tool result body */
  body: string;
}

/** Serialize a parsed notebook into the summary + per-cell text the tool returns. */
export function serializeNotebookForModel(result: ReadNotebookResult): SerializedNotebook {
  const summary = `[${summarizeNotebook(result)}]`;
  const cells = result.cells.map(serializeCellForModel);
  return {
    summary,
    cells,
    body: [summary, ...cells].join('\n\n'),
  };
}
