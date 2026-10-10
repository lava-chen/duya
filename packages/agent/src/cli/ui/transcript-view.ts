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
 */

import type { Block, TranscriptModel } from './blocks.js';
import { capLines } from './width.js';

/** How a transcript is currently being drawn. */
export interface RenderOptions {
  /** Show full thinking text rather than the collapsed one-line summary. */
  readonly expanded: boolean;
  /** Show tool results beneath their call line. */
  readonly showToolResults: boolean;
  /** Result lines kept per tool. Bounds a JSON blob's layout cost. */
  readonly toolResultLines: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  expanded: false,
  showToolResults: true,
  toolResultLines: 5,
};

/** Blessed tag for a colour, kept in one place so they stay consistent. */
const c = {
  bold: (s: string) => `{bold}${s}{/bold}`,
  green: (s: string) => `{green-fg}${s}{/green-fg}`,
  brightGreen: (s: string) => `{brightGreen-fg}${s}{/brightGreen-fg}`,
  red: (s: string) => `{red-fg}${s}{/red-fg}`,
  brightRed: (s: string) => `{brightRed-fg}${s}{/brightRed-fg}`,
  yellow: (s: string) => `{yellow-fg}${s}{/yellow-fg}`,
  cyan: (s: string) => `{cyan-fg}${s}{/cyan-fg}`,
  magenta: (s: string) => `{magenta-fg}${s}{/magenta-fg}`,
  gray: (s: string) => `{gray-fg}${s}{/gray-fg}`,
} as const;

/** Marker for a call still running. */
const RUNNING = '⏺';
/** Marker for a call that succeeded. */
const OK = '✔';
/** Marker for a call that failed. */
const FAILED = '✖';

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

/**
 * Apply ONE style to payload text.
 *
 * Exists to make two mistakes impossible rather than merely discouraged:
 *
 * 1. **Nesting.** `c.brightGreen(c.bold('›'))` produces
 *    `{brightGreen-fg}{bold}›{/bold}{/brightGreen-fg}`, and blessed's tag parser
 *    does not consume a closing tag whose opener it has already left. The
 *    outer `{/brightGreen-fg}` survived into the output, so every user message
 *    on a live TUI read `{brightGreen-fg}{/brightGreen-fg} 你是谁`. Measured on a
 *    real screen. Styles are therefore applied FLAT here: never one inside
 *    another.
 * 2. **Forgetting the escape.** Every helper in this file escapes its payload,
 *    so data can never be read as markup.
 */
function tagged(style: (s: string) => string, payload: string): string {
  return style(escapeTags(payload));
}

/** One tool call, as its call line plus optional result lines. */
function renderTool(block: Extract<Block, { kind: 'tool' }>, options: RenderOptions): string {
  const label = block.preview === '' ? block.name : `${block.name}(${block.preview})`;

  let head: string;
  switch (block.status) {
    case 'running':
      head = `${c.cyan(RUNNING)} ${escapeTags(label)}`;
      break;
    case 'ok':
      head = `${c.brightGreen(OK)} ${escapeTags(label)}`;
      break;
    case 'error':
      head = `${c.red(FAILED)} ${escapeTags(label)}`;
      break;
  }

  const lines = [head];
  if (block.status === 'running' || !options.showToolResults) return lines.join('\n');
  if (block.result === undefined || block.result.trim() === '') return lines.join('\n');

  const body = capLines(block.result.trimEnd(), options.toolResultLines);
  for (const line of body.split('\n')) {
    lines.push(`    ${tagged(c.gray, line)}`);
  }
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
): string {
  if (!options.expanded) {
    const suffix = block.finalized ? '' : '…';
    // Flat, not gray(`magenta(…)`) — see `tagged`.
    return tagged(c.magenta, `⏳ thinking${suffix} (${block.text.length} chars)`);
  }
  return `${tagged(c.magenta, '💭 thinking')}\n${tagged(c.gray, block.text)}`;
}

function renderBlock(block: Block, options: RenderOptions): string {
  switch (block.kind) {
    case 'user':
      // FLAT: one style, no nesting, payload escaped. `›` lost its bold to
      // achieve that, which is the trade the leak measured out.
      return tagged(c.brightGreen, `› ${block.text}`);
    case 'assistant':
      return escapeTags(block.text);
    case 'thinking':
      return renderThinking(block, options);
    case 'tool':
      return renderTool(block, options);
    case 'error':
      // Full width, never collapsed: an error the reader cannot see is an
      // error they will hit again next turn.
      return tagged(c.brightRed, `✗ ${block.message}`);
    case 'notice':
      return tagged(c.gray, block.text);
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
  return model.blocks.map((block) => renderBlock(block, options)).join('\n');
}

/** Render a single block. Exposed so the shell can repaint one line. */
export function renderOneBlock(block: Block, options: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  return renderBlock(block, options);
}
