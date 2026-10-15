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
