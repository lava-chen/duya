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

import { sgrParameterFor, type SpanColor } from '../core/color.js';
import { hasAttr, sameStyle, type StyledSpan } from '../core/span.js';

/** CSI introducer. */
const CSI = '\x1b[';
/** ESC. */
const ESC = '\x1b';

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

/** A background is the foreground code shifted up by ten (30→40, 90→100). */
function backgroundParameterFor(color: SpanColor): string {
  return color.kind === 'indexed' ? `48;5;${color.index}` : String(Number(sgrParameterFor(color)) + 10);
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
 * ## OSC 8 is deliberately absent
 *
 * `linkId` is carried on the span and ignored here. Hyperlinks change what the
 * terminal does with a click, not what it draws, and the tag vocabulary has no
 * spelling for them yet; emitting them now would make the two paths differ for
 * a feature nobody has asked to see on screen (plan 615 §O3).
 */
export function spansToAnsi(spans: readonly StyledSpan[]): string {
  let out = '';
  /** The style the terminal is in, or null before anything has been written. */
  let written: StyledSpan | null = null;

  for (const span of spans) {
    if (span.text === '') continue;
    if (written === null || !sameStyle(written, span)) {
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
  return out;
}
