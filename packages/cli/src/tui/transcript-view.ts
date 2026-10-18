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
 * ## The trail
 *
 * Execution — tool calls and thinking — hangs under the message that started
 * it, drawn as the tree minimax-code draws:
 *
 *     ● Let me look at the schema.
 *     (continuation lines indent under the anchor)
 *
 *     ├ ✔ Explored 3 operations
 *     │  ├ src/a.ts
 *     │  │   line1
 *     │  └ src/b.ts
 *     └ ✔ bash(ls -la)
 *         a
 *
 * Four rules make that hold together:
 *
 *  1. A UNIT is a maximal run of tool calls in one family; a run of TWO OR
 *     MORE gets one header row that summarises it (`Explored 3 operations`)
 *     plus one child row per call. The header is what makes a batch read as a
 *     batch — without it the first call looks like a parent and the rest like
 *     odd sub-calls, which is exactly how it looked before.
 *  2. The connector at column 0 (`├`/`└`) says whether another execution unit
 *     follows. Its marker sits at column 2, so every node's text starts there.
 *  3. A body is ALWAYS two columns right of its own row's text: node bodies at
 *     column 4, group children at column 4 and their bodies at column 6.
 *  4. One blank row separates units that are not connected. "Connected" is
 *     execution followed by execution — a tool after a tool, or after
 *     thinking. Anything else (a paragraph, a notice) starts a new stanza.
 *
 * Only the markers change the text, never the line count of a block: the block
 * model is a flat list, `renderTranscript` joins blocks with `'\n'`, and
 * `TUIApp.revealSelectedBlock` locates the selection by summing per-block
 * heights. A separator row therefore belongs to the block BELOW it, so the sum
 * stays honest and no per-block `+1` appears anywhere.
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
import { escapeTags } from './markdown/escape.js';
import { renderInlineTokens, rawTagPair, tokenizeInline } from './markdown/inline.js';

export { escapeTags } from './markdown/escape.js';

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
  /**
   * Let thinking blocks into the transcript at all.
   *
   * Default true. Hidden is not the same as collapsed: a collapsed block still
   * costs a row and can be expanded, while a hidden one is absent from the
   * plan — which is what someone who does not want to read reasoning wants.
   */
  readonly showThinking?: boolean;
  /** Theme token → blessed tag body. Defaults to the dark palette. */
  readonly theme?: ThemeTags;
  /**
   * Visible column budget for block renderers that span the pane width
   * (horizontal rules). Omitted means "unknown": width-aware renderers fall
   * back to their pre-`width` fixed shapes, which is what keeps every existing
   * caller and test byte-identical until the shell starts injecting it.
   */
  readonly width?: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  expanded: false,
  showToolResults: true,
  toolResultLines: 5,
};

/**
 * One style per call. The style FUNCTIONS stay flat — each wraps its argument
 * in exactly one tag pair — but the inline tokenizer composes them, so a
 * rendered line can carry nested pairs (`{bold}…{accent}…{/accent}…{/bold}`).
 * Blessed restores the outer style on a close (plan 614 §3.5), which is what
 * makes that composition safe; the "no nesting" rule this interface once
 * enforced applied to hand-written call sites and is superseded for the
 * tokenizer path.
 */
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
 * Lives in `markdown/escape.ts` so the inline tokenizer can use it without a
 * module cycle; re-exported here because every existing caller (overlays,
 * windows, the shell) imports it from this module.
 */

/** Render the useful Markdown subset without trusting model text as Blessed markup. */
function renderInlineMarkdown(text: string, styles: Styles): string {
  return renderInlineTokens(tokenizeInline(text), styles);
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
function renderAssistant(text: string, finalized: boolean, styles: Styles, width?: number): string {
  const markdown = finalized
    ? renderAssistantMarkdown(text, styles, width)
    : renderAssistantMarkdown(splitStreamCommit(text).safe, styles, width);
  return anchorAssistant(markdown, styles);
}

/**
 * The assistant anchor.
 *
 * `●` at column 0 is what the execution connectors below point AT: without it
 * a `├` at column 0 hangs from nothing. Every other line indents to the anchor's
 * text column so wrapped prose keeps one left edge.
 */
const ASSISTANT_ANCHOR = '●';

function anchorAssistant(markdown: string, styles: Styles): string {
  const lines = markdown.split('\n');
  const anchored = lines.map((line, index) => {
    if (index === 0) return `${styles.bold(ASSISTANT_ANCHOR)} ${line}`;
    // A blank line stays blank: trailing spaces are noise in a copied
    // transcript and blessed would paint them either way.
    return line === '' ? line : `  ${line}`;
  });
  return anchored.join('\n');
}

/** Render Markdown structure while keeping code and plain text safe for Blessed. */
function renderAssistantMarkdown(text: string, styles: Styles, width?: number): string {
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
      const level = (heading[1] ?? '#').length;
      const text = renderInlineMarkdown(heading[2] ?? '', styles);
      // Levels 1–2 read as document titles: heading colour AND bold. Deeper
      // levels stay single-colour. The `#` marks themselves are Markdown
      // syntax aimed at a browser, not content — they do not print (D5).
      if (level <= 2) {
        const headingTag = rawTagPair(styles.heading);
        const boldTag = rawTagPair(styles.bold);
        output.push(`${headingTag.open}${boldTag.open}${text}${boldTag.close}${headingTag.close}`);
      } else {
        output.push(styles.heading(text));
      }
      continue;
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (listItem !== null) {
      flushParagraph();
      const indent = (listItem[1] ?? '').slice(0, 6);
      const raw = listItem[2] ?? '';
      // `-`/`*`/`+` are three spellings of one bullet; a terminal transcript
      // shows the bullet, not which hyphen the model chose. Ordered markers
      // keep their number — that part IS content (D5).
      const marker = raw === '-' || raw === '*' || raw === '+'
        ? styles.accent('•')
        : styles.accent(raw);
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
      // Span the pane when the caller knows its width; the old fixed eight
      // dashes stay the fallback so width-blind callers render unchanged.
      output.push(styles.muted('─'.repeat(Math.max(8, width ?? 8))));
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return output.join('\n');
}

/** Status glyph for one call, and for a batch's rolled-up header. */
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
 * The body of a shell tool: maybe an evidence line, then the output.
 *
 * The evidence line repeats the command only when the row's preview is CLIPPED
 * to one line — that is the case where `$ ` plus the whole command is the
 * reader's only chance to see what actually ran. The output goes through
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
  // The evidence line exists because the ROW's preview is clipped to one line.
  // When the preview IS the whole command there is nothing to add: repeating it
  // printed the same string twice, once in the label and once under it.
  if (command !== undefined && block.preview !== command) {
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

/**
 * A batch summary — the row that makes three calls read as ONE thing.
 *
 * minimax-code's rule, ported: the verb is chosen from the SET of tools in the
 * run (`Read 3 files`, `Searched 2 patterns`, `Explored 3 operations`), never
 * from the first one, because "read then grep" summarised as `Read` would be a
 * lie about half the batch.
 */
export interface GroupSummary {
  readonly action: string;
  readonly noun: string;
  readonly size: number;
  readonly failed: number;
  readonly running: boolean;
}

/** Search-family names, used to pick the batch verb. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'search_files']);

/** Listing-family names, used to pick the batch verb. */
const LIST_TOOLS: ReadonlySet<string> = new Set(['glob']);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replaceAll('-', '_');
}

type ExploreCategory = 'read' | 'search' | 'list';

/** Which kind of exploration a call is, for the batch verb. */
function exploreCategory(name: string): ExploreCategory {
  const normalized = normalizeToolName(name);
  if (SEARCH_TOOLS.has(normalized)) return 'search';
  if (LIST_TOOLS.has(normalized)) return 'list';
  return 'read';
}

/** Summarise a run of same-family calls. */
function summarizeGroup(run: readonly Extract<Block, { kind: 'tool' }>[]): GroupSummary {
  const running = run.some((block) => block.status === 'running');
  const failed = run.filter((block) => block.status === 'error').length;
  const size = run.length;
  const family = toolGroupKey(run[0]?.name ?? '');
  const pick = (done: string, active: string): string => (running ? active : done);

  if (family === 'shell') {
    return { action: pick('Ran', 'Running'), noun: 'commands', size, failed, running };
  }
  if (family === 'explore') {
    const categories = new Set(run.map((block) => exploreCategory(block.name)));
    // A mixed pass is `Explored`, never the verb of whichever call happened to
    // come first: `Read 3 files` over two reads and a grep would be a lie.
    if (categories.size > 1) {
      return { action: pick('Explored', 'Exploring'), noun: 'operations', size, failed, running };
    }
    const only = [...categories][0] ?? 'read';
    if (only === 'search') return { action: pick('Searched', 'Searching'), noun: 'patterns', size, failed, running };
    if (only === 'list') return { action: pick('Listed', 'Listing'), noun: 'paths', size, failed, running };
    return { action: pick('Read', 'Reading'), noun: 'files', size, failed, running };
  }
  // A family of one name (edit, todo, task…): the name IS the verb.
  return { action: run[0]?.name ?? 'Called', noun: 'calls', size, failed, running };
}

/** Marker for a whole batch: any running wins, then any failure. */
function groupStatusMark(summary: GroupSummary, styles: Styles): string {
  if (summary.running) return styles.accent('⏺');
  if (summary.failed === summary.size) return styles.error('✖');
  if (summary.failed > 0) return styles.warning('✖');
  return styles.success('✔');
}

/** The batch header row, without its connector. */
function groupHeadRow(summary: GroupSummary, styles: Styles): string {
  const label = `${summary.action} ${summary.size} ${summary.noun}`;
  const failure = summary.failed === 0 ? '' : styles.error(` · ${summary.failed} failed`);
  return `${groupStatusMark(summary, styles)} ${styles.bold(label)}${failure}`;
}

/** One tool call standing on its own: `read(src/a.ts)`. */
function toolNodeRow(
  block: Extract<Block, { kind: 'tool' }>,
  options: RenderOptions,
  styles: Styles,
  connector: '├' | '└',
): string {
  const label = block.preview === '' ? block.name : `${block.name}(${block.preview})`;
  return `${connector} ${toolStatusMark(block.status, styles)} ${escapeTags(label)}${toolDisclosureOf(block, options, styles)}`;
}

/** One call inside a batch: the bare target, at the batch's child column. */
function groupChildRow(
  block: Extract<Block, { kind: 'tool' }>,
  plan: BlockPlan,
  options: RenderOptions,
  styles: Styles,
): string {
  const target = block.preview === '' ? block.name : block.preview;
  return `${plan.rowPrefix}${styles.muted(escapeTags(target))}${toolDisclosureOf(block, options, styles)}`;
}

/** `[-]` / `[+ N lines]` for one tool call. */
function toolDisclosureOf(
  block: Extract<Block, { kind: 'tool' }>,
  options: RenderOptions,
  styles: Styles,
): string {
  const result = block.result?.trimEnd() ?? '';
  if (result.trim() === '') return '';
  const isExpanded = blockExpanded(block.id, options);
  const showDetails = options.collapsedBlockIds?.has(block.id) !== true &&
    (options.showToolResults || isExpanded);
  const resultLines = result.trim().split(/\r?\n/u).length;
  const unit = isShellTool(block.name) ? 'output lines' : 'lines';
  return toolDisclosure(true, resultLines, showDetails, styles, unit);
}

/**
 * What one block needs from its neighbours to draw itself.
 *
 * Computed once per render by `planTranscript` and reused by the cache, which
 * keys on every field — a connector flips from `├` to `└` when a LATER block
 * arrives, so a key that ignored neighbours would serve a stale row.
 */
export interface BlockPlan {
  /** Draw one empty separator row above this block. */
  readonly gap: boolean;
  readonly role: 'plain' | 'node' | 'group-head' | 'group-child';
  /** The `├`/`└` this block's own row starts with, or null when it draws none. */
  readonly connector: '├' | '└' | null;
  /** Prefix for a group child's row (four columns, ends in a space). */
  readonly rowPrefix: string;
  /** Prefix for this block's body rows. */
  readonly bodyIndent: string;
  /** Batch summary, on a group head only. */
  readonly group: GroupSummary | null;
}

interface Unit {
  readonly kind: 'group' | 'node' | 'plain';
  readonly blocks: readonly Block[];
  readonly group: GroupSummary | null;
}

/** A unit that draws a connector and takes part in the trail. */
function isTrailUnit(unit: Unit): boolean {
  return unit.kind !== 'plain';
}

/** Split the flat block list into the units the trail is drawn from. */
function buildUnits(blocks: readonly Block[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block === undefined) break;
    if (block.kind === 'tool') {
      const family = toolGroupKey(block.name);
      let end = index;
      while (end + 1 < blocks.length) {
        const next = blocks[end + 1];
        if (next === undefined || next.kind !== 'tool' || toolGroupKey(next.name) !== family) break;
        end += 1;
      }
      const run = blocks.slice(index, end + 1) as Array<Extract<Block, { kind: 'tool' }>>;
      units.push(run.length > 1
        ? { kind: 'group', blocks: run, group: summarizeGroup(run) }
        : { kind: 'node', blocks: run, group: null });
      index = end + 1;
      continue;
    }
    units.push({
      kind: block.kind === 'thinking' ? 'node' : 'plain',
      blocks: [block],
      group: null,
    });
    index += 1;
  }
  return units;
}

/**
 * Lay every block out: which units form the trail, where the connectors point,
 * and where the blank rows go.
 *
 * A separator belongs to the block BELOW it, so `Σ heights` stays the flattened
 * line count and `revealSelectedBlock` needs no per-block `+1`.
 */
export function planTranscript(blocks: readonly Block[]): BlockPlan[] {
  const units = buildUnits(blocks);
  const plans: BlockPlan[] = [];

  units.forEach((unit, position) => {
    const above = units[position - 1];
    const below = units[position + 1];
    // Connected = execution followed by execution. A paragraph or a notice
    // starts a new stanza, which is where the blank row goes.
    const connectedAbove = above !== undefined && isTrailUnit(above) && isTrailUnit(unit);
    const connectedBelow = below !== undefined && isTrailUnit(below) && isTrailUnit(unit);
    const gap = position > 0 && !connectedAbove;
    const connector: '├' | '└' = connectedBelow ? '├' : '└';

    if (unit.kind === 'group') {
      unit.blocks.forEach((_, childIndex) => {
        const last = childIndex === unit.blocks.length - 1;
        plans.push({
          gap: gap && childIndex === 0,
          role: childIndex === 0 ? 'group-head' : 'group-child',
          connector: childIndex === 0 ? connector : null,
          // `│ ├ ` / `  └ `: the rail continues only while another unit below
          // still belongs to the same trail.
          rowPrefix: `${connectedBelow ? '│ ' : '  '}${last ? '└' : '├'} `,
          // `│     ` / `      `: always sits two columns right of the target.
          bodyIndent: `${connectedBelow ? '│ ' : '  '}${last ? '  ' : '│ '}  `,
          group: unit.group,
        });
      });
      return;
    }

    plans.push({
      gap,
      role: unit.kind === 'node' ? 'node' : 'plain',
      connector: unit.kind === 'node' ? connector : null,
      rowPrefix: '',
      bodyIndent: connectedBelow ? '│   ' : '    ',
      group: null,
    });
  });

  return plans;
}

/** Everything about a plan that changes a block's rendered text. */
export function planKey(plan: BlockPlan): string {
  const group = plan.group === null
    ? '-'
    : `${plan.group.action}|${plan.group.noun}|${plan.group.size}|${plan.group.failed}|${plan.group.running ? 1 : 0}`;
  return [
    plan.gap ? 'g' : '-',
    plan.role,
    plan.connector ?? '-',
    plan.rowPrefix,
    plan.bodyIndent,
    group,
  ].join('|');
}

/** The rows under a node's own row: a tool result or a thinking preview. */
function nodeBody(
  block: Block,
  plan: BlockPlan,
  options: RenderOptions,
  styles: Styles,
): string[] {
  if (block.kind === 'thinking') {
    return thinkingBody(block, blockExpanded(block.id, options), styles, plan.bodyIndent);
  }
  if (block.kind !== 'tool') return [];

  const result = block.result?.trimEnd() ?? '';
  if (block.status === 'running' || result.trim() === '') return [];
  const isExpanded = blockExpanded(block.id, options);
  const showDetails = options.collapsedBlockIds?.has(block.id) !== true &&
    (options.showToolResults || isExpanded);
  if (!showDetails) return [];
  return toolBody(block, result, options, styles, plan.bodyIndent);
}

/** Render one block with the layout the plan asks for. */
export function renderPlannedBlock(
  block: Block,
  plan: BlockPlan,
  options: RenderOptions,
  styles: Styles,
): string[] {
  const rows: string[] = [];
  if (plan.gap) rows.push('');

  if (plan.role === 'plain') {
    rows.push(...renderBlock(block, options, styles).split('\n'));
    return rows;
  }

  if (plan.role === 'group-head') {
    rows.push(`${plan.connector ?? '└'} ${groupHeadRow(plan.group ?? summarizeGroup([]), styles)}`);
    // The head block IS the batch's first call, so its own target row follows
    // the summary — the batch reads as `Read 3 files` then three targets, not
    // as two of three targets.
    if (block.kind === 'tool') {
      rows.push(groupChildRow(block, plan, options, styles));
      rows.push(...nodeBody(block, plan, options, styles));
    }
    return rows;
  }

  if (plan.role === 'group-child' && block.kind === 'tool') {
    rows.push(groupChildRow(block, plan, options, styles));
    rows.push(...nodeBody(block, plan, options, styles));
    return rows;
  }

  // A node: a standalone tool call or a thinking block.
  const connector = plan.connector ?? '└';
  if (block.kind === 'thinking') {
    const expanded = blockExpanded(block.id, options);
    rows.push(
      `${connector} ${styles.thinking(`• ${thinkingSummary(block)}`)}${styles.muted(expanded ? ' [−]' : ' [+]')}`,
    );
  } else if (block.kind === 'tool') {
    rows.push(toolNodeRow(block, options, styles, connector));
  } else {
    rows.push(...renderBlock(block, options, styles).split('\n'));
    return rows;
  }
  rows.push(...nodeBody(block, plan, options, styles));
  return rows;
}

/**
 * Thinking, as a preview or in full.
 *
 * Ported from minimax-code (`mcode`)'s thinking cell, which is the reference
 * for this shape:
 *
 * - the head says what the block DID, not how much text it holds — `Thinking…`
 *   while it streams, `Thought for 1.2s` once it closes. A character count was
 *   the old evidence line; elapsed time is the same evidence with a number a
 *   reader can compare across turns.
 * - a collapsed block is a three-line PREVIEW, not an absence. Reasoning that
 *   is visible while it runs (tail-following, so the newest thought is the one
 *   on screen) and folded to its first three lines once done is what makes the
 *   transcript readable without a toggle. The `… N more lines` row is the
 *   disclosure, and `[+]`/`[-]` marks the toggle.
 * - long blocks are bounded in CHARACTERS before any line work, because
 *   splitting and tagging tens of kilobytes to keep three lines is work no
 *   reader ever sees. The bound follows the same edge as the preview so the
 *   visible window never jumps when the cut lands mid-block.
 *
 * The head is drawn by `renderPlannedBlock`, which owns the connector: thinking
 * is an execution node, so it carries the same `├`/`└` as a tool call.
 */

/** Preview budget in whole lines, matching minimax-code's collapsed cell. */
const THINKING_PREVIEW_LINES = 3;

/** Characters kept from a preview before line selection. See `renderThinking`. */
const THINKING_PREVIEW_MAX_CHARS = 2_000;

/** Head text: what the block did, and for how long it was doing it. */
function thinkingSummary(block: Extract<Block, { kind: 'thinking' }>): string {
  if (!block.finalized) return 'Thinking…';
  const durationMs = block.durationMs;
  if (durationMs === undefined || durationMs <= 0) return 'Thought';
  return `Thought for ${formatThinkingDuration(durationMs)}`;
}

/** `1.2s` under a minute, `2m05s` above it — same split minimax-code uses. */
function formatThinkingDuration(durationMs: number): string {
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}

/**
 * The body rows of a thinking block.
 *
 * While the block streams the window follows the TAIL, so the row that just
 * arrived is the row on screen; once it closes the window snaps to the HEAD,
 * which is where a reasoning block states its premise. This is minimax-code's
 * choice and it is the right one: a reader watching a run wants the newest
 * thought, a reader reviewing one wants the beginning.
 */
function thinkingBody(
  block: Extract<Block, { kind: 'thinking' }>,
  expanded: boolean,
  styles: Styles,
  indent = '    ',
): string[] {
  const source = block.text.replace(/\r\n?/gu, '\n').trimEnd();
  if (source === '') return [];

  if (expanded) return thinkingRows(source.split('\n'), styles, indent);

  const edge = block.finalized ? 'head' : 'tail';
  const { text, truncated } = boundThinkingText(source, edge);
  const lines = text.split('\n');
  if (lines.length <= THINKING_PREVIEW_LINES && !truncated) {
    return thinkingRows(lines, styles, indent);
  }

  const slice = edge === 'head'
    ? lines.slice(0, THINKING_PREVIEW_LINES)
    : lines.slice(-THINKING_PREVIEW_LINES);
  // Blank rows are what separates paragraphs in reasoning, so a slice can end
  // on one and waste a third of the budget on an empty line. Trim them from
  // the edges only — an inner blank still separates the two thoughts it sits
  // between. The omitted count is recomputed from what is actually shown.
  const kept = trimBlankEdges(slice);
  const omitted = lines.length - kept.length;
  // A character bound can hide more than `omitted` lines, so it reports the
  // kind of overflow rather than a count that would be a lie.
  const overflow = truncated
    ? `${edge === 'head' ? 'more' : 'earlier'} content`
    : `${omitted} ${edge === 'head' ? 'more' : 'earlier'} ${omitted === 1 ? 'line' : 'lines'}`;
  const hint = styles.muted(`${indent}… ${overflow}`);
  const rows = thinkingRows(kept, styles, indent);
  return edge === 'head' ? [...rows, hint] : [hint, ...rows];
}

/** Drop blank rows from both ends, keeping the blanks in between. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** One muted row per source line, at the node's body column. */
function thinkingRows(lines: readonly string[], styles: Styles, indent: string): string[] {
  return lines.map((line) => `${indent}${styles.muted(line)}`);
}

/** Cut a preview to the character bound along the edge the preview reads from. */
function boundThinkingText(text: string, edge: 'head' | 'tail'): { text: string; truncated: boolean } {
  if (text.length <= THINKING_PREVIEW_MAX_CHARS) return { text, truncated: false };
  const cut = edge === 'head'
    ? text.slice(0, THINKING_PREVIEW_MAX_CHARS)
    : text.slice(-THINKING_PREVIEW_MAX_CHARS);
  // Never leave half of a surrogate pair at the cut boundary: blessed would
  // lay out a lone surrogate as a replacement cell.
  const safe = edge === 'head'
    ? cut.replace(/[\uD800-\uDBFF]$/u, '')
    : cut.replace(/^[\uDC00-\uDFFF]/u, '');
  return { text: safe, truncated: true };
}

/** Whether per-block expansion applies to this block id. Exported for the cache. */
export function blockExpanded(id: string, options: RenderOptions): boolean {
  if (options.collapsedBlockIds?.has(id)) return false;
  return options.expanded || options.expandedBlockIds?.has(id) === true;
}

/** Blocks that never take part in the trail. */
function renderPlainBlock(block: Block, options: RenderOptions, styles: Styles): string {
  switch (block.kind) {
    case 'user':
      // FLAT: one style, no nesting, payload escaped. `›` lost its bold to
      // achieve that, which is the trade the leak measured out.
      return styles.user(`› ${block.text}`);
    case 'assistant':
      return renderAssistant(block.text, block.finalized, styles, options.width);
    case 'error':
      // Full width, never collapsed: an error the reader cannot see is an
      // error they will hit again next turn.
      return styles.error(`✗ ${block.message}`);
    case 'notice':
      return styles.muted(block.text);
    // Node kinds are drawn by the trail; render them standalone here.
    case 'thinking':
    case 'tool':
      return renderPlannedBlock(block, STANDALONE_PLAN, options, styles).join('\n');
  }
}

/** The plan for a block shown on its own (no trail above or below it). */
const STANDALONE_PLAN: BlockPlan = {
  gap: false,
  role: 'node',
  connector: '└',
  rowPrefix: '',
  bodyIndent: '    ',
  group: null,
};

export function renderBlock(block: Block, options: RenderOptions, styles: Styles): string {
  return renderPlainBlock(block, options, styles);
}

/**
 * The whole transcript as one tagged string.
 *
 * Returns `''` rather than throwing for an empty model, so the first render
 * after startup does not have to special-case itself.
 */
/**
 * The blocks this render shows.
 *
 * Filtering here rather than inside `planTranscript` keeps one rule for both
 * renderers (`renderTranscript` and the cached path): a plan stays index-
 * aligned with the array it was planned from, so hiding a block cannot shift
 * every later block's connector.
 */
export function visibleBlocks(blocks: readonly Block[], options: RenderOptions): readonly Block[] {
  if (options.showThinking !== false) return blocks;
  return blocks.filter((block) => block.kind !== 'thinking');
}

export function renderTranscript(
  model: TranscriptModel,
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  const styles = stylesOf(options);
  const blocks = visibleBlocks(model.blocks, options);
  const plans = planTranscript(blocks);
  const lines: string[] = [];

  blocks.forEach((block, index) => {
    const plan = plans[index];
    if (plan === undefined) return;
    const rows = renderPlannedBlock(block, plan, options, styles);
    if (block.id === options.selectedBlockId) {
      // The selection caret goes on the block's first NON-EMPTY row: a stanza
      // gap would otherwise swallow it and the reader would see nothing.
      const target = rows.findIndex((row) => row !== '');
      const at = target === -1 ? 0 : target;
      rows[at] = `${styles.accent('❯')} ${rows[at]}`;
    }
    lines.push(...rows);
  });

  return lines.join('\n');
}

/** Render a single block. Exposed so the shell can repaint one line. */
export function renderOneBlock(block: Block, options: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  return renderBlock(block, options, stylesOf(options));
}
