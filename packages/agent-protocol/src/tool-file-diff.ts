/**
 * Structured file-change diff carried in a tool result's `metadata`.
 *
 * A tool that mutates a file (edit / write / apply_patch) knows the pre-image
 * and the post-image at the moment it runs, so it is the only place a diff can
 * be computed without re-reading the file or guessing. This contract is what
 * that producer hands to every consumer: the CLI TUI renders it, the desktop
 * renderer can render it, and a future client can render it — none of them
 * re-derive it from prose.
 *
 * The shape is deliberately NOT a unified diff TEXT. A text diff would force
 * every consumer to re-parse git's hunk grammar, and would throw away the
 * line numbers this contract carries explicitly. The producer computes the
 * numbers once; consumers only map them onto pixels.
 *
 * This package has ZERO runtime dependencies and no schema library, so the
 * narrow below is hand-written on purpose.
 */

/** What a diff row represents relative to the pre-image. */
export type ToolDiffLineKind = 'context' | 'add' | 'remove';

/** One row of a file diff. */
export interface ToolDiffLine {
  readonly kind: ToolDiffLineKind;
  /** The line's text, without its trailing newline. */
  readonly text: string;
  /** 1-based line number in the pre-image; null when the line is an addition. */
  readonly oldLine: number | null;
  /** 1-based line number in the post-image; null when the line is a removal. */
  readonly newLine: number | null;
}

/** A contiguous group of diff rows sharing one region of the file. */
export interface ToolDiffHunk {
  /** 1-based first line of this hunk in the pre-image. */
  readonly oldStart: number;
  /** Number of pre-image lines this hunk covers. */
  readonly oldLines: number;
  /** 1-based first line of this hunk in the post-image. */
  readonly newStart: number;
  /** Number of post-image lines this hunk covers. */
  readonly newLines: number;
  readonly lines: readonly ToolDiffLine[];
}

/** One file's change set. */
export interface ToolFileDiff {
  /** Path the change applies to, as the producer resolved it. */
  readonly path: string;
  /** Pre-image path, when the change was a rename. */
  readonly oldPath?: string;
  /** Lines added in the post-image. */
  readonly added: number;
  /** Lines removed from the pre-image. */
  readonly removed: number;
  /**
   * True when the producer dropped the rows because the change was too large
   * to carry. `added` / `removed` stay exact so a summary line remains
   * truthful even though the rows are gone.
   */
  readonly truncated?: boolean;
  readonly hunks: readonly ToolDiffHunk[];
}

/** The `metadata` key a file-mutating tool writes its diff under. */
export const TOOL_FILE_DIFF_METADATA_KEY = 'diff';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalLineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readLineKind(value: unknown): ToolDiffLineKind | null {
  return value === 'context' || value === 'add' || value === 'remove' ? value : null;
}

function parseDiffLine(value: unknown): ToolDiffLine | null {
  if (!isRecord(value)) return null;
  const kind = readLineKind(value['kind']);
  if (kind === null) return null;
  const text = value['text'];
  if (typeof text !== 'string') return null;
  return {
    kind,
    text,
    oldLine: readOptionalLineNumber(value['oldLine']),
    newLine: readOptionalLineNumber(value['newLine']),
  };
}

function parseDiffHunk(value: unknown): ToolDiffHunk | null {
  if (!isRecord(value)) return null;
  const oldStart = value['oldStart'];
  const oldLines = value['oldLines'];
  const newStart = value['newStart'];
  const newLines = value['newLines'];
  if (
    typeof oldStart !== 'number' ||
    typeof oldLines !== 'number' ||
    typeof newStart !== 'number' ||
    typeof newLines !== 'number'
  ) {
    return null;
  }
  const rawLines = value['lines'];
  if (!Array.isArray(rawLines)) return null;
  const lines: ToolDiffLine[] = [];
  for (const raw of rawLines) {
    const line = parseDiffLine(raw);
    if (line === null) return null;
    lines.push(line);
  }
  return { oldStart, oldLines, newStart, newLines, lines };
}

function parseFileDiff(value: unknown): ToolFileDiff | null {
  if (!isRecord(value)) return null;
  const path = value['path'];
  if (typeof path !== 'string') return null;
  const added = value['added'];
  const removed = value['removed'];
  if (typeof added !== 'number' || typeof removed !== 'number') return null;
  const rawHunks = value['hunks'];
  if (!Array.isArray(rawHunks)) return null;
  const hunks: ToolDiffHunk[] = [];
  for (const raw of rawHunks) {
    const hunk = parseDiffHunk(raw);
    if (hunk === null) return null;
    hunks.push(hunk);
  }
  const oldPath = readOptionalString(value['oldPath']);
  const truncated = value['truncated'];
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    added,
    removed,
    ...(truncated === true ? { truncated: true } : {}),
    hunks,
  };
}

/**
 * Narrow an untrusted `metadata` value into a file-diff list.
 *
 * Returns null unless EVERY entry is well-formed: a partially-understood diff
 * would render as a file with unexplained gaps, which is worse than no diff.
 */
export function parseToolFileDiff(value: unknown): ToolFileDiff[] | null {
  if (!Array.isArray(value)) return null;
  const diffs: ToolFileDiff[] = [];
  for (const raw of value) {
    const diff = parseFileDiff(raw);
    if (diff === null) return null;
    diffs.push(diff);
  }
  return diffs;
}
