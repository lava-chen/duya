/**
 * Painting the composer's rows.
 *
 * ## Why this is its own module
 *
 * The composer is painted in two places — the full-screen body and the inline
 * rows — and the shell prompt is the one thing a reader must never miss: it
 * is the difference between "this goes to the model" and "this runs on my
 * machine". A pure function is the only way to prove the prompt is tinted
 * without a terminal in front of the test.
 */

import { escapeTags } from './markdown/escape.js';

/**
 * Where the shell prompt sits in the rows being painted.
 *
 * The row index differs between the full-screen body (the first body row) and
 * the inline rows (the first body row, one below the top rule). An empty
 * glyph means the draft is not a shell command and nothing is tinted.
 */
export interface ShellPrompt {
  /** Index of the row that carries the prompt column. */
  readonly row: number;
  /** The glyph to tint: `!` or `!!`. */
  readonly glyph: string;
}

/** No shell prompt: the draft is an ordinary message. */
export const NO_SHELL_PROMPT: ShellPrompt = { row: -1, glyph: '' };

/**
 * Paint one composer row.
 *
 * The text is escaped, so a `{` in the draft is never read as a tag. The
 * shell prompt, when the row carries one, is tinted in the error colour —
 * the same red codex paints its shell prompt in. Only the glyph is tinted:
 * the padding that holds the text's column is layout, not signal.
 */
export function paintComposerRow(
  row: string,
  index: number,
  options: { readonly errorTag: string; readonly shellPrompt: ShellPrompt },
): string {
  const glyph = options.shellPrompt.glyph;
  if (glyph === '' || index !== options.shellPrompt.row || !row.startsWith(glyph)) {
    return escapeTags(row);
  }
  const tag = options.errorTag;
  return `{${tag}}${glyph}{/${tag}}${escapeTags(row.slice(glyph.length))}`;
}
