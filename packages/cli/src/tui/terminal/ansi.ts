/**
 * ANSI control sequences, in one place.
 *
 * ## Why this file exists
 *
 * The TUI used to outsource its terminal vocabulary to blessed, which meant
 * every screen-model decision was blessed's decision. Moving to an inline
 * viewport means owning that vocabulary outright, and an owned vocabulary has
 * to be written down — because the sequences that matter here are exactly the
 * ones that look interchangeable and are not.
 *
 * ## The rule that governs the whole file
 *
 * **Never emit a sequence that can reach above the viewport.**
 *
 * A conventional full-screen app redraws freely: it owns every cell, so
 * `\x1b[2J` (erase display) and `\x1b[3J` (erase scrollback) are unremarkable.
 * An inline app does not own the rows above it — those are the terminal's
 * scrollback, which is where the conversation lives once it has scrolled off.
 * `\x1b[3J` would erase the conversation. Emitting it by accident is the single
 * worst bug this architecture can have, so `assertViewportSafe` exists and
 * every write path runs its output through it.
 *
 * Scrolling is therefore done with a *region*, never with the whole screen:
 * set DECSTBM to cover only the viewport, scroll inside it, reset. That is the
 * same primitive codex uses (`insert_history.rs:165-178`).
 */

import { backgroundParameterFor, sgrParameterFor, type SpanColor } from '../core/color.js';
import { hasAttr, safeHyperlink, sameStyle, type StyledSpan } from '../core/span.js';

/** CSI introducer. */
const CSI = '\x1b[';
/** ESC. */
const ESC = '\x1b';
/** OSC introducer: `ESC ]`. */
const OSC = '\x1b]';
/** OSC terminator. BEL rather than ST: see `setWindowTitle`. */
const BEL = '\x07';

/** Move the cursor to a 1-based row/column. */
export function cursorTo(row: number, column: number): string {
  return `${CSI}${row};${column}H`;
}

/** Move the cursor to the top-left of the screen. */
export function cursorHome(): string {
  return `${CSI}H`;
}

/** Erase from the cursor to the end of the line. */
export function eraseLineRight(): string {
  return `${CSI}K`;
}

/** Erase the entire line the cursor is on. */
export function eraseLine(): string {
  return `${CSI}2K`;
}

/**
 * Erase from the cursor to the end of the display.
 *
 * Safe in an inline viewport ONLY because the cursor is inside the viewport
 * and DECSTBM is not in effect; with a scroll region set, this erases to the
 * region bottom, not the screen bottom.
 */
export function eraseToEndOfDisplay(): string {
  return `${CSI}J`;
}

/**
 * Move down one line, scrolling the region up if already at its bottom.
 *
 * This is `RI` (reverse index). Inside a DECSTBM region whose bottom is the
 * last row, this is what pushes a new line into scrollback — the operation
 * codex calls "insert history above the viewport"
 * (`insert_history.rs:170-175`).
 */
export function reverseIndex(): string {
  return `${ESC}M`;
}

/**
 * Set the scrolling region to 1-based `top`..`bottom`.
 *
 * With `bottom === screenRows` this makes the viewport reach the bottom of the
 * screen, which is required for `reverseIndex` to push rows into scrollback
 * rather than into the rows above.
 */
export function setScrollRegion(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}

/** Reset the scrolling region to the whole screen. */
export function resetScrollRegion(): string {
  return `${CSI}r`;
}

/** Switch to the alternate screen buffer (DECSET 1049). */
export function enterAlternateScreen(): string {
  return `${CSI}?1049h`;
}

/** Return from the alternate screen buffer. */
export function exitAlternateScreen(): string {
  return `${CSI}?1049l`;
}

/**
 * Set the window and tab title (OSC 0).
 *
 * ## Why OSC 0 and not OSC 2
 *
 * OSC 2 sets the window title only; OSC 0 sets the icon name AND the window
 * title. Every tab bar a user is likely to look at — Windows Terminal, iTerm2,
 * VS Code with `tabs.title: "${sequence}"`, tmux's `set-titles` — reads the
 * window title, so the two behave identically there. Where they differ, OSC 0
 * also renames the taskbar/Dock entry, which is the surface that still answers
 * "which agent is this" when the terminal is behind another window.
 *
 * ## Why BEL and not ST
 *
 * Both terminate an OSC, but some terminal integrations surface a ST
 * terminator in process decorations even though they accept the title update.
 * BEL is the shorter encoding and the one every implementation accepts.
 *
 * ## What this function does NOT do
 *
 * It does not sanitise. Title text is assembled from model output, session
 * names and paths, and a raw `ESC` or `BEL` in that text closes the sequence
 * early and spills the remainder into the terminal as control bytes. That
 * policy lives in `terminal-title.ts`, which is the only caller in production.
 */
export function setWindowTitle(title: string): string {
  return `${OSC}0;${title}${BEL}`;
}

/** OSC string terminator (`ST`). Only the iTerm2 notification form needs it. */
const ST = `${ESC}\\`;

/**
 * Report the current working directory (OSC 7).
 *
 * Terminals use this for "open a new tab in the same directory". The URI is
 * built by `terminal-integration.ts`; this function only encodes it, because
 * a Windows path or a space in a directory name is not valid inside a `file:`
 * URI and a raw `BEL` in one would end the sequence early.
 */
export function reportWorkingDirectory(uri: string): string {
  return `${OSC}7;${uri}${BEL}`;
}

/**
 * Write to the terminal's clipboard (OSC 52, selection `c` = CLIPBOARD).
 *
 * This is the only clipboard path that works when the process is on the other
 * end of SSH: `pbcopy` / `clip` / `xclip` write the REMOTE machine's clipboard,
 * or do not exist at all, while OSC 52 travels back through the pty to the
 * machine the user is sitting at. Payload is base64 because an OSC body may
 * not contain BEL, ESC or a newline.
 */
export function setClipboard(base64: string): string {
  return `${OSC}52;c;${base64}${BEL}`;
}

/**
 * Desktop notification (OSC 9): kitty / WezTerm / Ghostty / Warp.
 *
 * iTerm2 has its own titled form below; Windows Terminal and VS Code ignore
 * OSC 9 entirely, which is why `notificationBackend` never selects this for
 * them.
 */
export function desktopNotification(text: string): string {
  return `${OSC}9;${text}${BEL}`;
}

/**
 * iTerm2's titled notification (OSC 777).
 *
 * Uses ST because that is the terminator iTerm2 documents for `notify` (BEL
 * is accepted by most terminals, but not part of this form's contract). The
 * title is fixed here — only the body is caller-supplied, and the caller
 * sanitises it.
 */
export function itermNotification(body: string): string {
  return `${OSC}777;notify;duya;${body}${ST}`;
}

/** Audible bell: the notification fallback when no OSC form is available. */
export function bell(): string {
  return BEL;
}

/**
 * Windows Terminal taskbar progress states (OSC 9;4).
 *
 * 0 removes the indicator, 1 sets a percentage, 2 is indeterminate, 3 is
 * paused, 4 is an error. The prefix is shared with OSC 9 notifications, which
 * is why `terminal-integration.ts` refuses to emit it outside Windows Terminal:
 * a terminal that reads `9;4;...` as `9;...` shows a garbage notification.
 */
export type TerminalProgressState = 0 | 1 | 2 | 3 | 4;

export function setProgress(state: TerminalProgressState, value = 0): string {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return `${OSC}9;4;${state};${percent}${BEL}`;
}

/** Show the cursor. */
export function showCursor(): string {
  return `${CSI}?25h`;
}

/** Hide the cursor. */
export function hideCursor(): string {
  return `${CSI}?25l`;
}

/** Synchronized output: begin a frame that must not be seen half-drawn. */
export function beginSynchronizedOutput(): string {
  return `${CSI}?2026h`;
}

/** Synchronized output: end the frame. */
export function endSynchronizedOutput(): string {
  return `${CSI}?2026l`;
}

/** Disable line wrap for the duration of a frame. */
export function disableLineWrap(): string {
  return `${CSI}?7l`;
}

/** Restore line wrap. */
export function enableLineWrap(): string {
  return `${CSI}?7h`;
}

/**
 * Sequences that destroy scrollback and must never reach a live terminal.
 *
 * `\x1b[3J` erases the scrollback buffer outright. In an inline TUI that is the
 * entire conversation history. Its presence in output is a bug, not a style
 * choice, so it is a hard failure rather than a lint.
 */
const FORBIDDEN_IN_INLINE: readonly { readonly sequence: string; readonly name: string }[] = [
  { sequence: '\x1b[3J', name: 'ED3 — erase scrollback' },
  { sequence: '\x1b[3J\x1b[H', name: 'ED3 + home — erase scrollback' },
];

/**
 * Refuse to emit output that would erase the terminal's scrollback.
 *
 * Throwing beats writing: a crash leaves the conversation on screen, whereas
 * one ED3 leaves a blank terminal and no explanation.
 */
export function assertViewportSafe(output: string): void {
  for (const forbidden of FORBIDDEN_IN_INLINE) {
    if (output.includes(forbidden.sequence)) {
      throw new Error(
        `refusing to write ${forbidden.name}: it would erase the conversation from the ` +
          `terminal scrollback, which an inline TUI does not own`,
      );
    }
  }
}

/** Move the cursor up `n` rows without changing the column. */
export function cursorUp(n: number): string {
  return n <= 0 ? '' : `${CSI}${n}A`;
}

/** Move the cursor down `n` rows without changing the column. */
export function cursorDown(n: number): string {
  return n <= 0 ? '' : `${CSI}${n}B`;
}

/**
 * Ask for the kitty keyboard protocol, disambiguating escape codes.
 *
 * The flags are PUSHED (`>`), not set, so whatever the user's other tools asked
 * for is restored by `popKittyKeyboardFlags` rather than guessed at. Flag 1 is
 * "disambiguate escape codes": it makes Enter, Tab, Escape and friends arrive
 * as `CSI … u` instead of the ambiguous `\r` / `\t` / bare ESC, which is what
 * makes Shift+Enter distinguishable at all.
 *
 * OFF by default. Turning it on rewrites the encoding of every key, and the only
 * way to know a terminal honours it is to watch what arrives — a terminal that
 * ignores the push simply keeps sending legacy bytes, which is why the parser
 * accepts both without being told which is in force.
 */
export function pushKittyKeyboardFlags(): string {
  return `${CSI}>1u`;
}

/** Restore the keyboard flags that were in force before the push. */
export function popKittyKeyboardFlags(): string {
  return `${CSI}<u`;
}

/**
 * SGR parameters for one span's style, in the order this renderer emits them.
 *
 * Attributes first, then the foreground, then the background — the order
 * `own/markup.ts` measured against blessed, kept here so the two paths produce
 * the same bytes for the same screen.
 */
function spanParameters(span: StyledSpan): string[] {
  const parameters: string[] = [];
  if (hasAttr(span, 'bold')) parameters.push('1');
  if (hasAttr(span, 'italic')) parameters.push('3');
  if (hasAttr(span, 'strike')) parameters.push('9');
  if (hasAttr(span, 'underline')) parameters.push('4');
  if (span.fg !== undefined) parameters.push(sgrParameterFor(span.fg));
  if (span.bg !== undefined) parameters.push(backgroundParameterFor(span.bg));
  return parameters;
}

/**
 * A background is the foreground code shifted up by ten (30→40, 90→100).
 *
 * The rule itself lives in `core/color.ts`, next to the colour vocabulary it
 * belongs to; this re-export keeps the historical import site working.
 */
export { backgroundParameterFor };

/**
 * The SGR parameters for a span, joined — what a CELL carries as its style.
 *
 * Exported because the own screen painter stores exactly this string per cell
 * and compares cells by it. Sharing the function is what keeps a cell painted
 * from spans and a cell painted from tags byte-identical: both end up with the
 * parameter list this produces.
 */
export function spanStyleParameters(span: StyledSpan): string {
  return spanParameters(span).join(';');
}

/** Whether a style asks the terminal to leave its default state. */
function isStyled(span: StyledSpan | null): boolean {
  if (span === null) return false;
  return (span.attrs ?? []).length > 0 || span.fg !== undefined || span.bg !== undefined;
}

/**
 * Serialise one line of spans to ANSI.
 *
 * ## Why the transitions, not the spans
 *
 * The obvious implementation emits a full style per span. That inflates every
 * line with resets and re-opens that change nothing, and — worse — it would
 * produce different bytes from the tag path for the same screen, which is the
 * one thing the parity tests exist to catch. So the style the terminal is
 * ACTUALLY in is tracked and only real changes are emitted: a bold run
 * containing a muted word emits `ESC[1m`, `ESC[m ESC[38;5;241m`, then back.
 *
 * That is the same rule `own/markup.ts` measured and `spansToTags` applies on
 * the tag side, reached independently here — which is why the test asserting
 * the two agree is a real check rather than a tautology.
 *
 * ## OSC 8 is a style transition, not a separate renderer
 *
 * `linkId` rides on the span and is part of `sameStyle`, so a link boundary is
 * a real style transition here. `safeHyperlink` validates the URL before any
 * OSC 8 goes out, and the tag path has an equivalent vocabulary —
 * `{link-<base64url>}` from `encodeHyperlinkTag` in `core/span.ts`, decoded by
 * `own/markup.ts` into the same `ESC]8;;…` bytes. Whether a link is CREATED
 * at all is decided upstream by `terminalEnv.hyperlinks` (see the footer
 * input at TUIApp.ts), not by either renderer: keeping that decision in one
 * place is what lets the parity tests compare the two byte streams.
 *
 * An older revision of this comment said OSC 8 was deliberately absent and
 * that the tag vocabulary did not exist. Both halves are stale — the code
 * below emits OSC 8, and `core/tags.ts` decodes the tag form.
 */
export function spansToAnsi(spans: readonly StyledSpan[]): string {
  let out = '';
  /** The style the terminal is in, or null before anything has been written. */
  let written: StyledSpan | null = null;
  let activeLink: string | null = null;

  for (const span of spans) {
    if (span.text === '') continue;
    if (written === null || !sameStyle(written, span)) {
      const nextLink = safeHyperlink(span.linkId);
      if (activeLink !== nextLink) {
        if (activeLink !== null) out += '\x1b]8;;\x1b\\';
        if (nextLink !== null) out += `\x1b]8;;${nextLink}\x1b\\`;
        activeLink = nextLink;
      }
      const parameters = spanParameters(span);
      // Reset only when the terminal is actually in a style: the first styled
      // run of a line therefore starts without a leading `ESC[m`, which is
      // what the tag path produces too.
      out += isStyled(written) ? `${CSI}m` : '';
      out += parameters.length === 0 ? '' : `${CSI}${parameters.join(';')}m`;
      written = span;
    }
    out += span.text;
  }

  if (isStyled(written)) out += `${CSI}m`;
  if (activeLink !== null) out += '\x1b]8;;\x1b\\';
  return out;
}

export { safeHyperlink } from '../core/span.js';

/**
 * Mouse reporting, SGR flavour.
 *
 * `1002` is button-event tracking: presses, releases and the wheel, without the
 * motion-only flood `1003` would send. `1006` switches the report format from
 * the legacy `ESC[M Cb Cx Cy` (three bytes, unable to express coordinates past
 * column 223) to `ESC[<b;x;yM`, which is why the parser in `own-key-parser.ts`
 * reads SGR and why enabling the pair together is not optional.
 *
 * Reporting captures button events as well as the wheel. Native selection
 * needs the terminal's modifier override (usually Shift), or reporting disabled.
 */
export function enableMouseReporting(): string {
  return `${CSI}?1002h${CSI}?1006h`;
}

/** Turn mouse reporting off. MUST run on exit, or the shell inherits it. */
export function disableMouseReporting(): string {
  return `${CSI}?1006l${CSI}?1002l`;
}

/**
 * Bracketed paste.
 *
 * Without it a paste arrives as a key storm: the editor receives thousands of
 * individual keypresses, so newlines submit and the paste is mangled. With it,
 * the terminal wraps the payload in `ESC[200~ … ESC[201~` and the app can tell
 * "the user typed this" from "this was inserted".
 */
export function enableBracketedPaste(): string {
  return `${CSI}?2004h`;
}

/** Turn bracketed paste off. MUST run on exit. */
export function disableBracketedPaste(): string {
  return `${CSI}?2004l`;
}
