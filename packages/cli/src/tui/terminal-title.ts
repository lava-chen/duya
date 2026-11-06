/**
 * The window/tab title duya puts on the terminal, and the rules that keep it
 * writable.
 *
 * ## Why a title at all
 *
 * Every other surface that tells the user "this session is working" is inside
 * the terminal. Once the window loses focus — or the user has five tabs open,
 * one per project — the tab bar is the only place that can answer it, and the
 * answer has to come from the program, because no shell can know a turn is
 * running.
 *
 * ## Why the text is untrusted
 *
 * A title is assembled from a session name, which is derived from the first
 * user message, which is arbitrary text. Placing arbitrary text inside an OSC
 * is not cosmetic: an `ESC` or `BEL` in it terminates the sequence early and
 * the remainder is interpreted as terminal input. A newline rewrites the row
 * the terminal is about to repaint. Bidi controls and zero-width characters can
 * make a title read differently from the bytes underneath it (the Trojan Source
 * family). So everything is filtered here, once, before a single byte reaches
 * the tty.
 *
 * ## Why GNU Screen gets ASCII only
 *
 * Screen's title parser truncates UTF-8 to a byte rather than a codepoint, so
 * the tail of a multi-byte character becomes a control byte that can terminate
 * the OSC and spill title text onto the screen. The cheap fix is to make the
 * whole title printable ASCII under Screen; a degraded title beats control
 * bytes in the terminal. Detection is `STY`, not `TERM`: tmux also commonly
 * reports `TERM=screen*`, but only Screen itself sets `STY`.
 *
 * ## Why this does not read or restore the previous title
 *
 * There is no portable query — no OSC that every terminal answers with its
 * current title — so "restore" would be a guess. `clear()` writes an empty
 * title instead, which every terminal treats as "fall back to your default".
 */

import { setWindowTitle } from './terminal/ansi.js';

/**
 * Upper bound on title length, in Unicode codepoints.
 *
 * Terminals truncate titles at a few hundred characters and tab bars show far
 * less than that. 120 keeps a CJK session name readable next to the app name
 * without spending the visible width on a title nobody can finish reading.
 */
export const MAX_TERMINAL_TITLE_CHARS = 120;

/** How the title may be encoded for the terminal currently in front of us. */
export type TerminalTitleEncoding = 'unicode' | 'ascii';

/**
 * Codepoints that render as nothing but can reorder or hide what is around
 * them: soft hyphen, combining grapheme joiner, Arabic letter mark, the bidi
 * embedding/override set, word joiner and friends, variation selectors, BOM,
 * and the interlinear annotation controls.
 */
function isInvisibleFormatting(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0x00ad || code === 0x034f || code === 0x061c || code === 0x180e) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x206f) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  if (code === 0xfeff) return true;
  if (code >= 0xfff9 && code <= 0xfffb) return true;
  if (code >= 0x1bca0 && code <= 0x1bca3) return true;
  if (code >= 0xe0100 && code <= 0xe01ef) return true;
  return false;
}

/**
 * Fold untrusted text into one bounded, single-line title.
 *
 * Whitespace (including the newlines and tabs that a pasted first message
 * carries) collapses to a single space; control characters and invisible
 * formatting are dropped; the result is truncated on a codepoint boundary.
 * Under `ascii` every non-ASCII codepoint becomes `?`, which is deliberately
 * lossy and deliberately visible — see the Screen note in the file header.
 */
export function sanitizeTerminalTitle(
  raw: string,
  encoding: TerminalTitleEncoding = 'unicode',
): string {
  let out = '';
  let written = 0;
  let pendingSpace = false;

  for (const ch of raw) {
    if (/\s/u.test(ch)) {
      // Only meaningful once something has been written, which also trims the
      // leading whitespace without a second pass.
      pendingSpace = out !== '';
      continue;
    }
    const code = ch.charCodeAt(0);
    // `/\p{Cc}/u` would cover this, but the explicit test keeps the intent
    // readable next to the invisible-formatting check.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (isInvisibleFormatting(ch)) continue;

    if (pendingSpace) {
      // A separator earns its column only when a visible character can follow
      // it: at the boundary the last character is worth more than the space in
      // front of it, so the space is dropped rather than truncating to "a ".
      if (written + 1 < MAX_TERMINAL_TITLE_CHARS) {
        out += ' ';
        written += 1;
      }
      pendingSpace = false;
    }

    if (written >= MAX_TERMINAL_TITLE_CHARS) break;
    out += encoding === 'ascii' && code > 0x7e ? '?' : ch;
    written += 1;
  }

  return out;
}

/** Whether a GNU Screen session owns this terminal. */
export function screenActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env['STY'] === 'string' && env['STY'] !== '';
}

/**
 * Whether duya may rename the terminal window.
 *
 * Windows Terminal's `suppressApplicationTitle` and VS Code's
 * `tabs.title` let a user opt out at the terminal, but neither is reachable
 * from a shell wrapper that starts duya for a specific project, and a title
 * that a script owns is a title duya must not fight over. `DUYA_TUI_TITLE=0`
 * is the process-local escape hatch.
 */
export function terminalTitleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DUYA_TUI_TITLE'] !== '0';
}

/** The OSC 0 bytes for `raw`, sanitised for `encoding`. */
export function terminalTitleSequence(
  raw: string,
  encoding: TerminalTitleEncoding = 'unicode',
): string {
  return setWindowTitle(sanitizeTerminalTitle(raw, encoding));
}

/**
 * The one string the tab bar shows.
 *
 * `app` names the program, `session` names which conversation — a tab bar that
 * only says "duya chat" is useless once there are three of them. The phase
 * marker is a single ASCII-safe glyph rather than an animation: every write to
 * the title makes tab bars repaint, and the working tail already carries the
 * moving spinner for anyone looking at the window itself.
 */
export type TerminalTitlePhase = 'idle' | 'working' | 'waiting';

export function composeTerminalTitle(options: {
  readonly app: string;
  readonly session?: string | null;
  readonly phase?: TerminalTitlePhase;
  readonly encoding?: TerminalTitleEncoding;
}): string {
  const phase = options.phase ?? 'idle';
  const ascii = (options.encoding ?? 'unicode') === 'ascii';
  const marker = phase === 'working' ? (ascii ? '> ' : '▶ ') : phase === 'waiting' ? '! ' : '';
  const session = (options.session ?? '').trim();
  return session === '' ? `${marker}${options.app}` : `${marker}${options.app} · ${session}`;
}

/** What the writer has to expose for a title to be safe to write at all. */
export interface TerminalTitleWriter {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

/**
 * Writes the title only when it changed, and only to a terminal.
 *
 * The de-duplication is not an optimisation. `setBusy` fires on every turn
 * boundary and the permission overlay toggles on every prompt; writing an
 * identical OSC 0 each time makes some terminals flash the tab, and some
 * window managers re-sort tabs on a title change.
 */
export class TerminalTitle {
  readonly encoding: TerminalTitleEncoding;
  private readonly writer: TerminalTitleWriter;
  private readonly enabled: boolean;
  /** Last title actually written; `null` before the first write. */
  private emitted: string | null = null;

  constructor(options: {
    readonly writer: TerminalTitleWriter;
    readonly encoding?: TerminalTitleEncoding;
    /** Override the tty check. Only tests need this. */
    readonly enabled?: boolean;
  }) {
    this.writer = options.writer;
    this.encoding = options.encoding ?? 'unicode';
    this.enabled = options.enabled ?? options.writer.isTTY === true;
  }

  /** Returns whether bytes were written. */
  set(text: string): boolean {
    if (!this.enabled) return false;
    const clean = sanitizeTerminalTitle(text, this.encoding);
    // An empty sanitised title is a no-op rather than a clear: only `clear()`
    // may wipe a title, so a caller passing a name that sanitises to nothing
    // cannot silently blank the tab.
    if (clean === '') return false;
    if (clean === this.emitted) return false;
    this.writer.write(setWindowTitle(clean));
    this.emitted = clean;
    return true;
  }

  /**
   * Return the title to the terminal's default.
   *
   * Written even when the last composed title was empty, as long as something
   * was emitted earlier — otherwise an interrupted session leaves the tab
   * labelled with a conversation the user has left.
   */
  clear(): boolean {
    if (!this.enabled || this.emitted === null) return false;
    this.writer.write(setWindowTitle(''));
    this.emitted = null;
    return true;
  }
}
