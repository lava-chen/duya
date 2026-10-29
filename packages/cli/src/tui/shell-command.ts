/**
 * The `!` prefix: a draft that runs a command instead of reaching the model.
 *
 * ## Why one module owns the rule
 *
 * Two places must agree on what a shell draft IS: the composer, which paints
 * the prefix as the prompt the moment it recognizes one, and the submit path,
 * which runs the command. If they disagreed, the composer would promise a
 * command that the submit path sends to the model as a message — so the rule
 * lives here and both read it.
 *
 * ## The rule
 *
 * The draft opens with a bang, after any leading blanks. `!!` additionally
 * keeps the run's output out of the next message's context.
 *
 * The composer draws the prefix in the prompt column instead of the chevron,
 * the way codex draws its shell prompt, and the draft's text starts after it.
 * The buffer keeps the prefix as ordinary text: the editor's undo, history and
 * paste all work on the text the user typed, and the submit path still sees
 * the bang it expects.
 */

/** The two prefixes a shell draft opens with. */
export type ShellPrefix = '!' | '!!';

/**
 * The glyph each prefix draws in the composer gutter.
 *
 * `!!` says in the gutter that the run's output stays out of the next
 * message's context, so it is drawn in full rather than reduced to one `!`.
 */
const SHELL_GLYPHS: Readonly<Record<ShellPrefix, string>> = {
  '!': '!',
  '!!': '!!',
};

/**
 * The width of the composer's prompt column.
 *
 * Two columns, like the chevron that normally stands there, so the text after
 * the prompt starts in the same column whichever prefix the draft opens with
 * and the body never shifts under the user.
 */
const PROMPT_COLUMNS = 2;

/** A draft that opens a local shell command. */
export interface ShellDraft {
  /** The prefix the draft opens with. */
  readonly prefix: ShellPrefix;
  /** The glyph the prompt column holds: `!` or `!!`. */
  readonly glyph: string;
  /** The prompt column's text: the glyph, padded to the column's width. */
  readonly prompt: string;
  /** The draft with the leading blanks and the prefix removed. */
  readonly body: string;
  /**
   * Code points of the draft the prompt covers: the leading blanks and the
   * bangs. The caret shifts left by this much.
   */
  readonly stripped: number;
  /** The command the prefix stands for. */
  readonly command: string;
}

/**
 * The shell draft a text opens with, or null when it is an ordinary message.
 *
 * The prefix is found after any leading blanks, because the submit path
 * trims the line before it looks for the bang: a draft that only differs by
 * leading blanks runs the same command.
 */
export function shellDraftOf(text: string): ShellDraft | null {
  const cells = Array.from(text);
  let index = 0;
  while (index < cells.length && /^\s$/u.test(cells[index] ?? '')) index += 1;
  if (cells[index] !== '!') return null;
  const prefix: ShellPrefix = cells[index + 1] === '!' ? '!!' : '!';
  const glyph = SHELL_GLYPHS[prefix];
  const stripped = index + glyph.length;
  const body = cells.slice(stripped).join('');
  return {
    prefix,
    glyph,
    prompt: glyph.padEnd(PROMPT_COLUMNS),
    body,
    stripped,
    command: body.trim(),
  };
}
