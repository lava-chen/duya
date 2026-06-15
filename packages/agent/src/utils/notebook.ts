/**
 * notebook - Jupyter notebook (.ipynb) parsing utilities
 *
 * Pure-function helpers used by file-parser/parsers/notebook.ts. Reads
 * a notebook from disk, validates its nbformat, and normalizes cells
 * into ProcessedCell shape suitable for serialization to the model.
 *
 * Mirrors the strategy in claude-code-haha/src/utils/notebook.ts but
 * adapted for duya:
 *   - cellId is 1-based (`cell-${index + 1}`) to match duya's
 *     1-based cell_range and line_range semantics
 *   - image outputs land in a sidecar directory, not in tool_result
 *   - per-output 10KB cap is local (duya has no shared formatOutput)
 */

import { readFile } from 'node:fs/promises';

// ============================================================
// Errors
// ============================================================

export class NotebookParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NotebookParseError';
  }
}

export class UnsupportedNbformatError extends Error {
  constructor(
    public readonly nbformat: number,
  ) {
    super(`Cannot read notebook: unsupported nbformat version ${nbformat} (only 3 and 4 supported)`);
    this.name = 'UnsupportedNbformatError';
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
  | {
      type: 'execute_result';
      text?: string;
      image?: { imagePath: string; mediaType: string; originalSize: number };
    }
  | {
      type: 'display_data';
      text?: string;
      image?: { imagePath: string; mediaType: string; originalSize: number };
    }
  | { type: 'error'; text: string };

export interface ProcessedCell {
  /** 0-based position in the notebook */
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

export interface ReadNotebookOptions {
  cellRange?: { start: number; end: number };
  sidecarDir?: string;
}

export interface ReadNotebookResult {
  cells: ProcessedCell[];
  language: string;
  /** Original nbformat 3 or 4, for summary header */
  nbformat: number;
  nbformatMinor: number;
  /** Sum of output text/image bytes — for summary header */
  totalOutputBytes: number;
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
// readNotebook
// ============================================================

const SUPPORTED_NBFORMATS = new Set([3, 4]);

/**
 * Read a .ipynb file from disk, validate nbformat, normalize cells.
 * Throws NotebookParseError or UnsupportedNbformatError on bad input.
 *
 * The cellRange option slices cells (1-indexed, inclusive) before
 * processing. sidecarDir is currently unused (image extraction
 * happens in extractOutputImage, called by the parser).
 */
export async function readNotebook(
  filePath: string,
  options: ReadNotebookOptions = {},
): Promise<ReadNotebookResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new NotebookParseError(
      `Cannot read notebook '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  let notebook: RawNotebook;
  try {
    notebook = JSON.parse(raw) as RawNotebook;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new NotebookParseError(
      `Cannot read notebook '${filePath}': invalid notebook JSON: ${reason}`,
      err,
    );
  }

  const nbformat = notebook.nbformat ?? 0;
  if (!SUPPORTED_NBFORMATS.has(nbformat)) {
    throw new UnsupportedNbformatError(nbformat);
  }

  const language =
    notebook.metadata?.language_info?.name ??
    notebook.metadata?.kernelspec?.language ??
    'python';

  const allCells = notebook.cells ?? [];
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

  const totalOutputBytes = cells.reduce((sum, c) => {
    if (!c.outputs) return sum;
    return sum + estimateOutputBytes(c.outputs);
  }, 0);

  return {
    cells,
    language,
    nbformat,
    nbformatMinor: notebook.nbformat_minor ?? 0,
    totalOutputBytes,
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
      // image extraction happens in the parser (needs sidecar dir);
      // this function only handles text.
      return {
        type: raw.output_type as 'execute_result' | 'display_data',
        text: text ? truncateOutputText(text).text : undefined,
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

function extractTextFromData(data: RawOutput['data']): string {
  if (!data) return '';
  const textPlain = data['text/plain'];
  if (typeof textPlain === 'string') return textPlain;
  if (Array.isArray(textPlain)) return textPlain.join('');
  return '';
}

function estimateOutputBytes(outputs: NotebookOutput[]): number {
  let total = 0;
  for (const o of outputs) {
    if (o.type === 'stream' || o.type === 'error') total += o.text.length;
    else if (o.type === 'execute_result' || o.type === 'display_data') {
      if (o.text) total += o.text.length;
    }
  }
  return total;
}

function validateCellRange(
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

export function isLargeOutput(
  outputs: NotebookOutput[],
  threshold: number = OUTPUT_TEXT_CAP,
): boolean {
  return estimateOutputBytes(outputs) > threshold;
}
