/**
 * file-diff-view.ts — render a structured file change as a diff block.
 *
 * ## Where the rows come from
 *
 * The rows are NOT computed here. A file-mutating tool computed them while it
 * still held the file's pre-image and post-image, and published them in its
 * result metadata (`@duya/agent-protocol/tool-file-diff`). This module only
 * paints them. That split is what lets every client show the SAME line
 * numbers: there is exactly one place the diff is derived, and it is the place
 * that could see both versions of the file.
 *
 * ## The shape
 *
 * codex's diff cell is the reference (`codex-rs/tui/src/diff_render.rs`):
 *
 *     12 │ export function boot() {
 *     13 │-const legacy = true;
 *     14 │+const store = createStore();
 *        ⋮
 *     20 │  render(store);
 *
 * A right-aligned line-number column, a `│` divider, a one-character sign
 * column, then the content. Hunk boundaries are a dim `⋮` rather than a
 * `@@ -a,b +c,d @@` header: the header is noise next to numbers that already
 * say where the change is.
 *
 * ## The colours
 *
 * A changed row is painted as TWO chips: the line number on its own fill, and
 * the sign plus content on the change's fill. The number sits on its own chip
 * so a reader can scan the column of numbers without the code's own colours
 * competing with them. A context row has no fill at all — untouched code is
 * not part of the change, and colouring it would make the change look bigger
 * than it is.
 *
 * The fills are 256-colour indices, never hex: `theme.ts` records why hex was
 * rejected (it quantises to the nearest 16-colour entry, which is not
 * controllable), and the dark/light pairs are codex's own 256-colour
 * fallbacks for its RGB fills.
 *
 * ## Why the rows are padded to the edge
 *
 * A background fill has to REACH the right edge or the chip ends mid-row and
 * the block reads as ragged. So a filled row is padded to the pane width with
 * spaces INSIDE the fill tag — the padding is what carries the colour, and
 * padding outside the tag would leave the last columns unpainted.
 *
 * The consequence is that a filled row occupies the full width, so the budget
 * is the pane width MINUS one column: a line that exactly fills the width
 * makes most terminals wrap on write, and a wrapped line moves every row below
 * it (`terminal/diff.ts`).
 */

import { escapeTags } from './markdown/escape.js';
import type { ThemeTags } from './theme.js';
import { visibleWidth, truncateToWidth } from './width.js';
import { extractPartialToolFields, extractPartialToolString } from '@duya/client-core';
import type { ToolDiffLine, ToolFileDiff } from '@duya/agent-protocol/tool-file-diff';

/** The divider between the line-number column and the content. */
const DIVIDER = ' │ ';

/** Rows a single file's diff may show before the middle is dropped. */
export const MAX_DIFF_VIEW_ROWS = 120;

export interface FileDiffViewOptions {
  /** Theme token → blessed tag body. */
  readonly tags: ThemeTags;
  /**
   * Visible columns of the pane the rows are drawn in. Omitted means
   * "unknown": the rows are then neither truncated nor padded.
   */
  readonly width?: number;
  /**
   * Columns the transcript's own indent already occupies. Counted out of the
   * budget, because the indent is drawn in front of every row.
   */
  readonly indentWidth?: number;
  /** Rows kept per file; omitted means every row. */
  readonly maxRows?: number;
}

/** Wrap already-safe text in one tag pair. */
function wrap(body: string, text: string): string {
  return `{${body}}${text}{/${body}}`;
}

/** Wrap raw text in one tag pair, escaping it for the tag parser. */
function tagged(body: string, text: string): string {
  return wrap(body, escapeTags(text));
}

/** The sign column of a row. */
function signOf(line: ToolDiffLine): string {
  if (line.kind === 'add') return '+';
  if (line.kind === 'remove') return '-';
  return ' ';
}

/**
 * The number a row shows.
 *
 * A removal shows the line it came FROM and an addition the line it went TO,
 * so the two rows of a replacement read as the same position in the file
 * rather than as two unrelated numbers. A row whose number is unknown — a
 * change still streaming in — shows a dot, which keeps the column's geometry
 * unchanged instead of reflowing when the number arrives.
 */
function numberOf(line: ToolDiffLine): string {
  const value = line.kind === 'remove' ? line.oldLine : line.newLine;
  return value === null || value === undefined ? '·' : String(value);
}

/** The widest line number the diff shows, for the column's width. */
function numberWidthOf(lines: readonly ToolDiffLine[]): number {
  let widest = 1;
  for (const line of lines) {
    for (const value of [line.oldLine, line.newLine]) {
      if (value !== null && value !== undefined) widest = Math.max(widest, String(value).length);
    }
  }
  return widest;
}

/** One row of a diff, with the hunk it belongs to. */
interface DiffEntry {
  readonly line: ToolDiffLine;
  readonly hunkIndex: number;
}

/**
 * The rows of one file's diff, with the middle dropped when there are too many.
 *
 * The middle is what gets dropped, not the tail: a diff's head says what the
 * change starts with and its tail says what it ends with, and the middle is
 * the part a reader scrolls past anyway.
 */
function selectRows(
  entries: readonly DiffEntry[],
  maxRows: number,
): { readonly rows: readonly DiffEntry[]; readonly hidden: number } {
  if (entries.length <= maxRows) return { rows: entries, hidden: 0 };
  const head = Math.max(1, Math.floor((maxRows - 1) / 2));
  const tail = Math.max(1, maxRows - 1 - head);
  return {
    rows: [...entries.slice(0, head), ...entries.slice(entries.length - tail)],
    hidden: entries.length - head - tail,
  };
}

/**
 * Paint one diff row.
 *
 * `budget` is the columns the CONTENT may use; the number column and the
 * divider are counted separately by the caller.
 */
function renderRow(
  line: ToolDiffLine,
  numberText: string,
  styles: ThemeTags,
  budget: number | undefined,
): string {
  const sign = signOf(line);
  const content = budget === undefined ? line.text : truncateToWidth(line.text, budget);

  if (line.kind === 'context') {
    // No fill on a context row: untouched code is not part of the change.
    return `${tagged(styles.diffGutter, numberText)}${DIVIDER}${sign}${escapeTags(content)}`;
  }

  const isAdd = line.kind === 'add';
  const numberBg = isAdd ? styles.diffNumBgAdd : styles.diffNumBgDel;
  const rowBg = isAdd ? styles.diffAddBg : styles.diffDelBg;
  const foreground = isAdd ? styles.diffAdd : styles.diffDel;

  const number = tagged(numberBg, numberText);
  const body = budget === undefined
    ? `${escapeTags(sign)}${escapeTags(content)}`
    // The padding lives INSIDE the fill, so the colour reaches the right edge.
    : `${escapeTags(sign)}${escapeTags(content)}${' '.repeat(Math.max(0, budget - visibleWidth(content)))}`;
  return `${number}${DIVIDER}${wrap(rowBg, wrap(foreground, body))}`;
}

/**
 * The file header of one diff: the path and the change's size.
 *
 * Only shown when more than one file changed — a single-file change already
 * says which file it was in the row above it, and repeating the path there is
 * noise.
 */
function renderFileHeader(diff: ToolFileDiff, styles: ThemeTags): string {
  const path = diff.oldPath === undefined ? diff.path : `${diff.oldPath} → ${diff.path}`;
  return `${tagged(styles.diffHeader, path)}  ${tagged(styles.diffAdd, `+${diff.added}`)} ${tagged(styles.diffDel, `-${diff.removed}`)}`;
}

/**
 * Render a structured file change as the rows of a transcript body.
 *
 * Returns the rows WITHOUT the transcript indent; the caller owns that,
 * because the indent is the caller's geometry.
 */
export function renderFileDiffRows(
  diffs: readonly ToolFileDiff[],
  failures: readonly string[] | undefined,
  options: FileDiffViewOptions,
): string[] {
  const rows: string[] = [];
  const maxRows = options.maxRows ?? MAX_DIFF_VIEW_ROWS;
  const showHeaders = diffs.length > 1;

  for (const diff of diffs) {
    if (showHeaders) rows.push(renderFileHeader(diff, options.tags));

    if (diff.truncated === true) {
      // The producer kept the counts and dropped the rows, so the summary
      // stays truthful while the rows are gone.
      rows.push(tagged(options.tags.muted, '… change too large to show row by row'));
      continue;
    }

    const entries: DiffEntry[] = [];
    diff.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) entries.push({ line, hunkIndex });
    });

    const numberWidth = numberWidthOf(entries.map((entry) => entry.line));
    const contentBudget = options.width === undefined
      ? undefined
      : Math.max(
        8,
        options.width - (options.indentWidth ?? 0) - numberWidth - DIVIDER.length - 2,
      );

    const { rows: selected, hidden } = selectRows(entries, maxRows);
    let previousHunk: number | undefined;
    for (const entry of selected) {
      if (previousHunk !== undefined && entry.hunkIndex !== previousHunk) {
        rows.push(`${' '.repeat(numberWidth)}${DIVIDER}${tagged(options.tags.diffHunk, '⋮')}`);
      }
      previousHunk = entry.hunkIndex;
      const numberText = numberOf(entry.line).padStart(numberWidth, ' ');
      rows.push(renderRow(entry.line, numberText, options.tags, contentBudget));
    }
    if (hidden > 0) {
      rows.push(`${' '.repeat(numberWidth)}${DIVIDER}${tagged(options.tags.muted, `… ${hidden} lines hidden`)}`);
    }
  }

  if (failures !== undefined) {
    for (const failure of failures) {
      rows.push(tagged(options.tags.error, `✗ ${failure}`));
    }
  }

  return rows;
}

/**
 * The one-line summary a tool row shows instead of its line count.
 *
 * `(+12 -3)` is the change's real size, which the generic `[+ N lines]`
 * disclosure cannot express: that count is how many lines of PROSE the result
 * had, and for a file change the reader wants the size of the CHANGE.
 */
export function fileDiffCounts(diffs: readonly ToolFileDiff[]): { added: number; removed: number } | null {
  if (diffs.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    added += diff.added;
    removed += diff.removed;
  }
  return { added, removed };
}

/** The tools whose arguments carry a file body worth previewing. */
const STREAMING_FILE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch']);

/** True when this tool's arguments are a file body the preview can show. */
export function isStreamingFileTool(toolName: string): boolean {
  return STREAMING_FILE_TOOLS.has(toolName);
}

/** What the preview knows about the change that is still arriving. */
interface StreamingContent {
  readonly rows: readonly ToolDiffLine[];
  readonly added: number;
  readonly removed: number;
  /** Whether the rows know their own line numbers yet. */
  readonly numbered: boolean;
}

/**
 * What the arguments received so far say about the change.
 *
 * This is deliberately NOT a diff. A diff needs the file's pre-image, and a
 * client has no way to get it: the change may be a brand-new file, and the
 * old content lives in the tool that will run, not in the arguments the model
 * is still writing. So the preview shows WHAT IS BEING WRITTEN — the lines
 * themselves — and leaves the change's shape to the final diff.
 */
function streamingContentOf(toolName: string, raw: string): StreamingContent | null {
  if (toolName === 'write') {
    const content = extractPartialToolFields(raw)['content'];
    if (content === undefined) return null;
    const lines = content.split('\n');
    // A trailing newline leaves an empty last element that is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return {
      rows: lines.map((text, index) => ({ kind: 'add', text, oldLine: null, newLine: index + 1 })),
      added: lines.length,
      removed: 0,
      numbered: true,
    };
  }

  if (toolName === 'edit') {
    const added = extractPartialToolString(raw, 'new_string');
    if (added === undefined) return null;
    const removed = extractPartialToolString(raw, 'old_string') ?? '';
    const lines = added.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return {
      rows: lines.map((text) => ({ kind: 'add', text, oldLine: null, newLine: null })),
      added: lines.length,
      removed: removed === '' ? 0 : removed.split('\n').length,
      numbered: false,
    };
  }

  if (toolName === 'apply_patch') {
    const patch = extractPartialToolFields(raw)['patch'];
    if (patch === undefined) return null;
    const rows: ToolDiffLine[] = [];
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
      // The patch's own header lines (`*** Update File:`) and hunk markers
      // (`@@`) are structure, not content.
      if (line.startsWith('+')) {
        rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: null });
        added += 1;
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'remove', text: line.slice(1), oldLine: null, newLine: null });
        removed += 1;
      }
    }
    return { rows, added, removed, numbered: false };
  }

  return null;
}

/**
 * The preview shown while a file-mutating call's arguments are still arriving.
 *
 * ## Why the preview is bounded
 *
 * The transcript is committed to the terminal's scrollback a row at a time, and
 * a committed row can never be un-committed. A preview that grew without a
 * bound would push its own top rows into the scrollback MID-STREAM, where they
 * would freeze at whatever they said when they scrolled off — the user's
 * history would keep a half-written file.
 *
 * So the preview is capped to the live area's height, which is what keeps every
 * one of its rows inside the region the surface rewrites. The cap is the
 * caller's `maxRows`: zero means "no room", and then the count alone is the
 * whole preview.
 *
 * ## Why the rows are the tail
 *
 * The newest lines are what the model is writing RIGHT NOW, and they are what
 * the reader is watching for. The head of a long file was written seconds ago.
 */
export function renderStreamingFileRows(
  toolName: string,
  raw: string,
  options: FileDiffViewOptions,
): string[] {
  const content = streamingContentOf(toolName, raw);
  if (content === null) return [];

  // The tilde says "provisional": the count is what has arrived, not what the
  // finished change will be.
  const counts = content.removed > 0 ? `~+${content.added} -${content.removed}` : `~+${content.added}`;
  const header = tagged(options.tags.muted, counts);

  const maxRows = options.maxRows ?? 0;
  if (maxRows <= 0) return [header];

  const numberWidth = content.numbered
    ? numberWidthOf(content.rows)
    : 1;
  const contentBudget = options.width === undefined
    ? undefined
    : Math.max(
      8,
      options.width - (options.indentWidth ?? 0) - numberWidth - DIVIDER.length - 2,
    );

  const selected = content.rows.slice(-maxRows);
  const rows = selected.map((line) => {
    const numberText = numberOf(line).padStart(numberWidth, ' ');
    return renderRow(line, numberText, options.tags, contentBudget);
  });
  return [header, ...rows];
}

/**
 * The visible width of a rendered row, tags excluded.
 *
 * Blessed's escape for a literal brace is the tag body `{open}`, which the
 * terminal draws as ONE cell even though it is five characters of source.
 * Counting it as zero would under-report the row by four columns per brace, so
 * it is put back as a brace before the tags are stripped.
 *
 * Exported for the tests that assert a row never exceeds the pane width.
 */
export function diffRowWidth(text: string): number {
  return visibleWidth(text.replace(/\{open\}/gu, '{').replace(/\{[^}]*\}/gu, ''));
}
