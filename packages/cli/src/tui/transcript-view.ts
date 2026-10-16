/**
 * Block model to blessed tag markup.
 *
 * ## Why this is separate from the blessed shell
 *
 * Rendering a block involves no terminal state at all — it is a pure function
 * from a block to a tagged string. Keeping it out of `TUIApp` means the one
 * thing most likely to be got wrong (the `⏺`/`✔`/`✖` transitions, the collapse
 * accounting, the error styling) is reachable from a test that needs no TTY,
 * which is the only kind of test that can run in CI.
 *
 * ## On blessed tags and CJK
 *
 * Blessed inserts a placeholder cell after every double-width character when
 * it parses content (`unicode.js`'s `chars.wide` regex, "to put a blank char
 * after wide chars to be eaten"). So the strings produced here are measured in
 * code points and blessed does the cell accounting. Padding here therefore
 * uses `.length` on spaces only, which are the one thing that is one cell per
 * unit in every script.
 *
 * ## Themes
 *
 * Colours come from `theme.ts` tokens via `RenderOptions.theme`. The default
 * palette is the dark one, whose tags are byte-identical to the literals this
 * file used before theming — the markup tests pin them either way.
 *
 * ## Tool groups
 *
 * Consecutive tool calls in the same FAMILY render as a GROUP: the first call
 * carries the name, the rest become `└ <preview>` continuations. The family is
 * `toolGroupKey(name)` — read/glob/grep share one exploration family, bash and
 * powershell one shell family, everything else is its own family — so a glob
 * followed by a read is one search pass rather than two heads.
 *
 * A continuation that is a DIFFERENT tool from its head carries the name
 * (`└ grep pattern: x`) because the head's name no longer describes it.
 *
 * Only the head marker changes — never the line count — because
 * `TUIApp.revealSelectedBlock` locates the selection by summing
 * `renderOneBlock` heights, and a group that renders one line shorter than the
 * sum would scroll the selection off by that many lines.
 */

import type { Block, TranscriptModel } from './blocks.js';
import { splitStreamCommit } from './stream-commit.js';
import {
  formatToolResult,
  isShellTool,
  selectShellOutput,
  toolGroupKey,
} from './tool-render.js';
import { capLines, truncateToWidth, visibleWidth } from './width.js';
import { DARK_THEME_TAGS, type ThemeTags } from './theme.js';

/** How a transcript is currently being drawn. */
export interface RenderOptions {
  /** Show full thinking text rather than the collapsed one-line summary. */
  readonly expanded: boolean;
  /** Show tool results beneath their call line. */
  readonly showToolResults: boolean;
  /** Result lines kept per tool. Bounds a JSON blob's layout cost. */
  readonly toolResultLines: number;
  /** Expand these blocks individually, even while the rest stay compact. */
  readonly expandedBlockIds?: ReadonlySet<string>;
  /** Collapse these blocks individually, even while the transcript is expanded. */
  readonly collapsedBlockIds?: ReadonlySet<string>;
  /** Mark one block as the current history selection. */
  readonly selectedBlockId?: string;
  /** Theme token → blessed tag body. Defaults to the dark palette. */
  readonly theme?: ThemeTags;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  expanded: false,
  showToolResults: true,
  toolResultLines: 5,
};

/** One flat style per call: no nesting, payload always escaped. */
export interface Styles {
  bold(s: string): string;
  muted(s: string): string;
  accent(s: string): string;
  success(s: string): string;
  error(s: string): string;
  warning(s: string): string;
  user(s: string): string;
  thinking(s: string): string;
  diffAdd(s: string): string;
  diffDel(s: string): string;
  heading(s: string): string;
  link(s: string): string;
}

/** Build the style set for a render. The dark palette is the default. */
export function stylesOf(options: Pick<RenderOptions, 'theme'>): Styles {
  const tags = options.theme ?? DARK_THEME_TAGS;
  const flat = (tag: string, s: string): string => `{${tag}}${escapeTags(s)}{/${tag}}`;
  return {
    bold: (s) => `{bold}${escapeTags(s)}{/bold}`,
    muted: (s) => flat(tags.muted, s),
    accent: (s) => flat(tags.accent, s),
    success: (s) => flat(tags.success, s),
    error: (s) => flat(tags.error, s),
    warning: (s) => flat(tags.warning, s),
    user: (s) => flat(tags.user, s),
    thinking: (s) => flat(tags.thinking, s),
    diffAdd: (s) => flat(tags.diffAdd, s),
    diffDel: (s) => flat(tags.diffDel, s),
    heading: (s) => flat(tags.heading, s),
    link: (s) => flat(tags.link, s),
  };
}

/**
 * Escape text for blessed's tag parser.
 *
 * A literal `{` in model output would otherwise be read as the start of a tag
 * and silently swallowed, so agent output containing braces — which is most
 * JSON, most code, and most stack traces — would lose characters. `{` has to
 * become `\{` for blessed to print it literally.
 */
export function escapeTags(text: string): string {
  return text.replace(/\{/g, '\\{');
}

/** Render the useful Markdown subset without trusting model text as Blessed markup. */
function renderInlineMarkdown(text: string, styles: Styles): string {
  const tokenPattern = /(`+)([^`]+?)\1|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;
  let rendered = '';
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index;
    const token = match[0];
    rendered += escapeTags(text.slice(cursor, index));

    if (match[2] !== undefined) {
      rendered += styles.muted(match[2]);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      rendered += styles.bold(match[3] ?? match[4] ?? '');
    } else if (match[5] !== undefined || match[6] !== undefined) {
      rendered += styles.accent(match[5] ?? match[6] ?? '');
    } else if (match[7] !== undefined && match[8] !== undefined) {
      rendered += `${escapeTags(match[7])} ${styles.link(`(${match[8]})`)}`;
    } else {
      rendered += escapeTags(token);
    }

    cursor = index + token.length;
  }

  return rendered + escapeTags(text.slice(cursor));
}

function renderCodeBlock(language: string, lines: readonly string[], styles: Styles): string {
  const label = language.trim().split(/\s+/u)[0] || 'code';
  const diff = isDiffBlock(label, lines);
  const lineCount = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
  const diffLabel = diff && label.toLowerCase() !== 'diff' ? ' · diff' : '';
  const rendered = [styles.muted(`  ┌─ ${label}${diffLabel} · ${lineCount} ─`)];
  const numberWidth = String(Math.max(1, lines.length)).length;
  for (const [index, line] of lines.entries()) {
    const number = String(index + 1).padStart(numberWidth, ' ');
    const gutter = styles.muted(`  │ ${number} │`);
    rendered.push(`${gutter} ${diff ? renderDiffLine(line, styles) : escapeTags(line)}`);
  }
  rendered.push(styles.muted('  └─'));
  return rendered.join('\n');
}

/** Recognize an explicit diff fence or the stable markers in a unified patch. */
function isDiffBlock(language: string, lines: readonly string[]): boolean {
  if (/^(?:diff|patch)$/iu.test(language)) return true;
  if (lines.some((line) => /^(?:diff --git |Index: )/u.test(line))) return true;
  return lines.some((line) => /^@@ .* @@/u.test(line)) &&
    lines.some((line) => /^(?:\+\+\+ |--- )/u.test(line));
}

/** One flat style per diff line keeps Blessed tags balanced and payload safe. */
function renderDiffLine(line: string, styles: Styles): string {
  if (/^(?:diff --git |Index: |index |new file mode |deleted file mode |rename (?:from|to) )/u.test(line)) {
    return styles.accent(line);
  }
  if (/^\+\+\+ /u.test(line)) return styles.diffAdd(line);
  if (/^--- /u.test(line)) return styles.diffDel(line);
  if (/^@@/u.test(line)) return styles.accent(line);
  if (line.startsWith('+')) return styles.diffAdd(line);
  if (line.startsWith('-')) return styles.diffDel(line);
  return escapeTags(line);
}

/**
 * GFM pipe-table delimiter row: `|---|:---:|---:|`.
 *
 * Cell-wise, not regex-over-the-whole-line, because a single-column table's
 * `|---|` has no INNER pipe and a whole-line pattern that demands two columns
 * would render one-column tables as raw text. Every cell must be dashes with
 * optional colons; the caller additionally requires the header row to contain
 * a pipe, so a plain `---` horizontal rule never lands here.
 */
function isTableDelimiter(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length >= 1 && cells.every((cell) => /^:?-{1,}:?$/u.test(cell));
}

/** Split one pipe row into trimmed cells, honoring `\|` escapes. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|\s*$/u, '');
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, '|').trim());
}

/** A column wider than this is truncated; a table one cell wide is unreadable anyway. */
const TABLE_CELL_MAX_WIDTH = 48;

type TableAlignment = 'left' | 'center' | 'right';

function alignmentOf(delimiterCell: string): TableAlignment {
  const cell = delimiterCell.trim();
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.endsWith(':')) return 'right';
  return 'left';
}

/**
 * A GFM pipe table as aligned ruled text.
 *
 * Rendered, not dumped: the raw `|---|` source is markup meant for a browser,
 * and in a terminal it reads as corruption. Columns are sized by VISIBLE width
 * (`visibleWidth`, CJK-aware — padding by `.length` would misalign every row
 * containing an ideograph), cells render inline markdown, and the delimiter
 * row's colons drive alignment.
 */
function renderTable(
  headerLine: string,
  delimiterLine: string,
  dataLines: readonly string[],
  styles: Styles,
): string {
  const delimiterCells = splitTableRow(delimiterLine);
  const aligns: TableAlignment[] = delimiterCells.map(alignmentOf);
  const dataRows = dataLines.map((row) => splitTableRow(row));
  const rows = [splitTableRow(headerLine), ...dataRows];

  const columnCount = Math.max(aligns.length, ...rows.map((row) => row.length));
  const widths: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < columnCount; c += 1) {
      const width = visibleWidth(row[c] ?? '');
      widths[c] = Math.max(widths[c] ?? 0, Math.min(width, TABLE_CELL_MAX_WIDTH));
    }
  }

  const alignFor = (c: number): TableAlignment => aligns[c] ?? 'left';

  /**
   * Pad one cell to its column width. `render` is injected because the header
   * must stay FLAT (`accent(escapeTags(text))` — one style, no nesting) while
   * body cells render inline markdown, whose tags must never be padded over.
   */
  const padCell = (raw: string, c: number, render: (text: string) => string): string => {
    const clipped = visibleWidth(raw) > TABLE_CELL_MAX_WIDTH
      ? truncateToWidth(raw, TABLE_CELL_MAX_WIDTH)
      : raw;
    const gap = Math.max(0, widths[c] as number - visibleWidth(clipped));
    switch (alignFor(c)) {
      case 'right': return `${' '.repeat(gap)}${render(clipped)}`;
      case 'center': {
        const left = Math.floor(gap / 2);
        return `${' '.repeat(left)}${render(clipped)}${' '.repeat(gap - left)}`;
      }
      default: return `${render(clipped)}${' '.repeat(gap)}`;
    }
  };

  const renderRow = (
    row: readonly string[],
    render: (text: string) => string,
  ): string => row.map((cell, c) => padCell(cell, c, render)).join(styles.muted(' │ '));

  // Rows shorter than the table keep their trailing cells EMPTY rather than
  // shrinking the join: ragged row lengths would otherwise shift every column
  // border after the gap.
  const normalize = (row: readonly string[]): string[] =>
    Array.from({ length: columnCount }, (_, c) => row[c] ?? '');

  const lines: string[] = [
    renderRow(normalize(rows[0] ?? []), (text) => styles.accent(escapeTags(text))),
  ];
  lines.push(styles.muted(widths.map((w) => '─'.repeat(w + 2)).join('┼')));
  for (const row of dataRows) {
    lines.push(renderRow(normalize(row), (text) => renderInlineMarkdown(text, styles)));
  }
  return lines.join('\n');
}

/**
 * Render one assistant block, honouring whether it is still arriving.
 *
 * A finalized block is complete and renders in full. A streaming one withholds
 * a still-growing pipe table, whose column widths would otherwise be recomputed
 * — and every border moved — on each arriving row. Nothing else is held back;
 * see `stream-commit.ts` for why an unfinished code fence is deliberately shown.
 */
function renderAssistant(text: string, finalized: boolean, styles: Styles): string {
  if (finalized) return renderAssistantMarkdown(text, styles);
  const commit = splitStreamCommit(text);
  return renderAssistantMarkdown(commit.safe, styles);
}

/** Render Markdown structure while keeping code and plain text safe for Blessed. */
function renderAssistantMarkdown(text: string, styles: Styles): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(paragraph.map((line) => renderInlineMarkdown(line, styles)).join('\n'));
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== null) {
      flushParagraph();
      const delimiter = fence[1] ?? '```';
      const marker = delimiter[0] ?? '`';
      const body: string[] = [];

      while (index + 1 < lines.length) {
        index += 1;
        const codeLine = lines[index] ?? '';
        const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(codeLine);
        if (closingFence !== null && closingFence[1]?.[0] === marker &&
          (closingFence[1]?.length ?? 0) >= delimiter.length) {
          break;
        }
        body.push(codeLine);
      }

      output.push(renderCodeBlock(fence[2] ?? '', body, styles));
      continue;
    }

    // A pipe row is a TABLE only when the NEXT line is a delimiter row; a
    // sentence that happens to contain `|` must keep rendering as text.
    if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1] ?? '')) {
      flushParagraph();
      let end = index + 2;
      while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim() !== '') {
        end += 1;
      }
      output.push(renderTable(
        lines[index] ?? '',
        lines[index + 1] ?? '',
        lines.slice(index + 2, end),
        styles,
      ));
      index = end - 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      if (output.length > 0 && output[output.length - 1] !== '') output.push('');
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      output.push(`${styles.heading(`${heading[1] ?? '#'} `)}${renderInlineMarkdown(heading[2] ?? '', styles)}`);
      continue;
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (listItem !== null) {
      flushParagraph();
      const indent = (listItem[1] ?? '').slice(0, 6);
      const marker = styles.accent(listItem[2] ?? '•');
      const content = listItem[3] ?? '';
      const task = /^\[([ xX])\]\s+(.*)$/u.exec(content);
      if (task !== null) {
        const checked = (task[1] ?? '').toLowerCase() === 'x';
        // A pending checkbox stays muted; a completed one takes success.
        const checkboxTagged = checked ? styles.success('☑') : styles.muted('☐');
        output.push(`${indent}${marker} ${checkboxTagged} ${renderInlineMarkdown(task[2] ?? '', styles)}`);
      } else {
        output.push(`${indent}${marker} ${renderInlineMarkdown(content, styles)}`);
      }
      continue;
    }

    const quote = /^ {0,3}>\s?(.*)$/u.exec(line);
    if (quote !== null) {
      flushParagraph();
      output.push(`${styles.muted('│')} ${renderInlineMarkdown(quote[1] ?? '', styles)}`);
      continue;
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line)) {
      flushParagraph();
      output.push(styles.muted('────────'));
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return output.join('\n');
}

/** Status glyph and its style, shared by group heads and continuations. */
function toolStatusMark(
  status: 'running' | 'ok' | 'error' | 'unknown',
  styles: Styles,
): string {
  switch (status) {
    case 'running': return styles.accent('⏺');
    case 'ok': return styles.success('✔');
    case 'error': return styles.error('✖');
    case 'unknown': return styles.muted('?');
  }
}

/** Shared disclosure suffix: `[-]` when shown, `[+ N <unit>]` when not. */
function toolDisclosure(
  hasResult: boolean,
  resultLineCount: number,
  showDetails: boolean,
  styles: Styles,
  unit = 'lines',
): string {
  if (!hasResult) return '';
  return showDetails
    ? styles.muted(' [-]')
    : styles.muted(` [+ ${resultLineCount} ${unit}]`);
}

/**
 * The body of a shell tool: the command on an evidence line, then its output.
 *
 * The command is repeated here rather than left to the head because the head's
 * preview is clipped to one line — `$ ` plus the WHOLE command is the reader's
 * only chance to see what actually ran. The output goes through
 * `selectShellOutput`, whose choice of head/tail depends on the status.
 */
function shellBody(
  block: Extract<Block, { kind: 'tool' }>,
  result: string,
  options: RenderOptions,
  styles: Styles,
  indent: string,
): string[] {
  // A failure gets double the budget: the message the reader needs is usually
  // at the end, and minimax-code's preview budget does the same.
  const budget = block.status === 'error'
    ? options.toolResultLines * 2
    : options.toolResultLines;
  const selected = selectShellOutput(result, block.status, Math.max(1, budget));
  const lines: string[] = [];
  const command = block.command;
  if (command !== undefined) {
    lines.push(`${indent}${styles.accent('$')} ${escapeTags(command)}`);
  }
  // A shell command that PRINTS a diff (`git diff`, patch output) keeps its
  // colours — the selection is the same text the generic path would have seen,
  // and muting it would lose the one thing that output is for.
  if (isDiffBlock('text', selected)) {
    lines.push(...renderCodeBlock('diff', selected, styles).split('\n').map((line) => `${indent}${line}`));
    return lines;
  }
  for (const line of selected) lines.push(`${indent}${styles.muted(line)}`);
  return lines;
}

/** The body of any other tool: a known report formatted, or muted raw text. */
function plainBody(
  block: Extract<Block, { kind: 'tool' }>,
  result: string,
  options: RenderOptions,
  styles: Styles,
  indent: string,
): string[] {
  // An error gets double the budget: the message the reader needs is usually
  // at the end of the report (minimax-code's preview budget does the same).
  const budget = block.status === 'error' ? options.toolResultLines * 2 : options.toolResultLines;
  const formatted = formatToolResult(block.name, result);
  const body = capLines(formatted, budget);
  const bodyLines = body.split('\n');
  // Diff detection only applies to pass-through results — the formatters never
  // emit diffs, and re-colouring grep rows as one would be wrong.
  if (formatted === result && isDiffBlock('text', bodyLines)) {
    return renderCodeBlock('diff', bodyLines, styles).split('\n').map((line) => `${indent}${line}`);
  }
  return bodyLines.map((line) => `${indent}${styles.muted(line)}`);
}

/** Shared result body: shell tools get an evidence line, everything else raw. */
function toolBody(
  block: Extract<Block, { kind: 'tool' }>,
  result: string,
  options: RenderOptions,
  styles: Styles,
  indent: string,
): string[] {
  return isShellTool(block.name)
    ? shellBody(block, result, options, styles, indent)
    : plainBody(block, result, options, styles, indent);
}

/** One tool call, as its call line plus optional result lines. */
function renderTool(block: Extract<Block, { kind: 'tool' }>, options: RenderOptions, styles: Styles): string {
  const label = block.preview === '' ? block.name : `${block.name}(${block.preview})`;
  const isExpanded = blockExpanded(block.id, options);
  const result = block.result?.trimEnd() ?? '';
  const hasResult = result.trim() !== '';
  const showDetails = options.collapsedBlockIds?.has(block.id) !== true &&
    (options.showToolResults || isExpanded);

  const head = `${toolStatusMark(block.status, styles)} ${escapeTags(label)}`;
  const resultLines = hasResult ? result.trim().split(/\r?\n/u).length : 0;
  const unit = isShellTool(block.name) ? 'output lines' : 'lines';
  const lines = [`${head}${toolDisclosure(hasResult, resultLines, showDetails, styles, unit)}`];
  if (block.status === 'running' || !showDetails) return lines.join('\n');
  if (!hasResult) return lines.join('\n');

  lines.push(...toolBody(block, result, options, styles, '    '));
  return lines.join('\n');
}

/**
 * A tool call that continues a group started by the block above it.
 *
 * The group's head name is `headName`; when it differs from this block's name
 * the head shows the name too, because a `└ read src/a.ts` under a `grep` head
 * would claim the wrong tool. Line count matches `renderTool` exactly — see the
 * module comment. Exported for the per-block cache, which must reproduce the
 * group decision itself (the `continuation` flag is part of its cache key).
 */
export function renderToolContinuation(
  block: Extract<Block, { kind: 'tool' }>,
  options: RenderOptions,
  styles: Styles,
  headName?: string,
): string {
  const isExpanded = blockExpanded(block.id, options);
  const result = block.result?.trimEnd() ?? '';
  const hasResult = result.trim() !== '';
  const showDetails = options.collapsedBlockIds?.has(block.id) !== true &&
    (options.showToolResults || isExpanded);

  const preview = block.preview === '' ? '…' : block.preview;
  const sameName = headName === undefined || headName === block.name;
  const body = sameName ? `└ ${preview}` : `└ ${block.name} ${preview}`;
  const head = `${toolStatusMark(block.status, styles)} ${styles.muted(escapeTags(body))}`;
  const resultLines = hasResult ? result.trim().split(/\r?\n/u).length : 0;
  const unit = isShellTool(block.name) ? 'output lines' : 'lines';
  const lines = [`${head}${toolDisclosure(hasResult, resultLines, showDetails, styles, unit)}`];
  if (block.status === 'running' || !showDetails) return lines.join('\n');
  if (!hasResult) return lines.join('\n');

  lines.push(...toolBody(block, result, options, styles, '    '));
  return lines.join('\n');
}

/**
 * Thinking, collapsed or expanded.
 *
 * Collapsed, it still reports the character count: a thinking block that is
 * silently absent is indistinguishable from a run that did nothing, and the
 * count is the only evidence the work happened.
 */
function renderThinking(
  block: Extract<Block, { kind: 'thinking' }>,
  options: RenderOptions,
  styles: Styles,
): string {
  if (!blockExpanded(block.id, options)) {
    const suffix = block.finalized ? '' : '…';
    // Flat, not muted(styles(…)) — see `tagged`.
    return styles.thinking(`⏳ thinking${suffix} (${block.text.length} chars) [+]`);
  }
  return `${styles.thinking('💭 thinking [−]')}\n${styles.muted(block.text)}`;
}

/** Whether per-block expansion applies to this block id. Exported for the cache. */
export function blockExpanded(id: string, options: RenderOptions): boolean {
  if (options.collapsedBlockIds?.has(id)) return false;
  return options.expanded || options.expandedBlockIds?.has(id) === true;
}

export function renderBlock(block: Block, options: RenderOptions, styles: Styles): string {
  switch (block.kind) {
    case 'user':
      // FLAT: one style, no nesting, payload escaped. `›` lost its bold to
      // achieve that, which is the trade the leak measured out.
      return styles.user(`› ${block.text}`);
    case 'assistant':
      return renderAssistant(block.text, block.finalized, styles);
    case 'thinking':
      return renderThinking(block, options, styles);
    case 'tool':
      return renderTool(block, options, styles);
    case 'error':
      // Full width, never collapsed: an error the reader cannot see is an
      // error they will hit again next turn.
      return styles.error(`✗ ${block.message}`);
    case 'notice':
      return styles.muted(block.text);
  }
}

/**
 * The whole transcript as one tagged string.
 *
 * Returns `''` rather than throwing for an empty model, so the first render
 * after startup does not have to special-case itself.
 */
export function renderTranscript(
  model: TranscriptModel,
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  const styles = stylesOf(options);
  const lines: string[] = [];
  // Only a tool block directly after a tool block of the SAME FAMILY joins a
  // group; any other block resets it. The head's NAME is remembered too, so a
  // cross-family-name continuation (a `read` under a `grep`) can carry it.
  let pendingGroupKey: string | null = null;
  let pendingGroupName: string | null = null;

  for (const block of model.blocks) {
    const key = block.kind === 'tool' ? toolGroupKey(block.name) : null;
    const continuation = block.kind === 'tool' && key !== null && pendingGroupKey === key;
    const rendered = continuation
      ? renderToolContinuation(block, options, styles, pendingGroupName ?? undefined)
      : renderBlock(block, options, styles);
    lines.push(block.id === options.selectedBlockId
      ? `${styles.accent('❯')} ${rendered}`
      : rendered);
    pendingGroupKey = key;
    pendingGroupName = block.kind === 'tool' ? block.name : null;
  }

  return lines.join('\n');
}

/** Render a single block. Exposed so the shell can repaint one line. */
export function renderOneBlock(block: Block, options: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  return renderBlock(block, options, stylesOf(options));
}
