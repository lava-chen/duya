/**
 * Viewport diffing: the core of an inline TUI.
 *
 * ## The one rule
 *
 * Rewrite rows inside the viewport. Never emit anything that reaches a row
 * above it. Rows above the viewport are the terminal's scrollback, and that is
 * where the conversation lives once it has scrolled off — they are not ours to
 * erase, scroll, or move.
 *
 * This is the same discipline minimax-code applies, in as many words at
 * `engine/tui-main-screen.ts:304`: *"Viewport-only redraws preserve the
 * terminal's native scrollback."*
 *
 * ## Why not just redraw every row
 *
 * Redrawing the viewport in full would be correct and simpler. It is also the
 * difference between a streaming answer that reads as text arriving and one
 * that flickers, because an unchanged row that gets rewritten is a row the
 * terminal must repaint. The viewport is small and bounded, so the diff is
 * cheap — there is no performance argument for skipping it, only a legibility
 * one.
 *
 * ## Why line wrap is disabled around every frame
 *
 * A line that exactly fills the terminal width makes most terminals wrap on
 * write. The cursor then sits at the start of the next row, the rest of the
 * frame is written one row lower than intended, and the last row scrolls the
 * viewport up by one — which, in an inline TUI, pushes a live row into
 * scrollback and permanently displaces the conversation. Disabling wrap for
 * the duration of a frame removes the whole class of bug instead of shaving
 * one column off every line.
 */

import {
  assertViewportSafe,
  beginSynchronizedOutput,
  cursorTo,
  disableLineWrap,
  enableLineWrap,
  endSynchronizedOutput,
  eraseLineRight,
} from './ansi.js';

export interface ViewportGeometry {
  /** 1-based screen row the viewport's first row occupies. */
  readonly topRow: number;
  /** How many rows the viewport has. */
  readonly rows: number;
}

export interface ViewportFrame extends ViewportGeometry {
  /** The byte sequence to write. */
  readonly output: string;
  /** How many rows this frame actually rewrote — never more than `rows`. */
  readonly rewritten: number;
  /** True when every row was rewritten: the first frame, or after a resize. */
  readonly fullRedraw: boolean;
}

/**
 * Build the frame that turns the viewport from `previous` into `next`.
 *
 * Both arguments are the VISIBLE WINDOW — already windowed by the caller to at
 * most `rows` rows, because windowing is a layout decision and this is a write
 * decision. Passing more rows than the viewport has is a bug, and it is thrown
 * on rather than truncated: a silent truncation in a TUI means the user loses
 * text and nothing says so.
 *
 * Both are ALREADY ANSI. The conversion happens once, in `InlineSurface`, so
 * what is compared here is byte-for-byte what is written — and so there is one
 * tag parser in the inline path instead of two that could disagree (plan 615
 * Phase 5). Passing tagged rows would compare tag strings and then write them
 * as literal text, which is how a `{gray-fg}` ends up visible in the terminal.
 */
export function renderViewportFrame(
  previous: readonly string[],
  next: readonly string[],
  geometry: ViewportGeometry,
  options: { readonly forceFullRedraw?: boolean } = {},
): ViewportFrame {
  if (next.length > geometry.rows) {
    throw new Error(
      `viewport frame has ${next.length} rows but the viewport is ${geometry.rows}: ` +
        `the caller must window the document before handing it over`,
    );
  }

  // Nothing on screen yet, or the caller knows the terminal was resized.
  // Deriving this from a length mismatch would flag "the document is shorter
  // than the viewport" as a first frame, which it is not.
  const fullRedraw = options.forceFullRedraw === true || previous.length === 0;

  const previousAnsi = previous;
  const nextAnsi = next;

  const parts: string[] = [disableLineWrap(), beginSynchronizedOutput()];
  let rewritten = 0;

  for (let row = 0; row < geometry.rows; row += 1) {
    const after = nextAnsi[row];
    // An absent row is an empty row, which still has to be blanked on the
    // first frame or whatever blessed/the shell left there stays visible.
    const before = previousAnsi[row];
    if (!fullRedraw && before === after) continue;

    parts.push(cursorTo(geometry.topRow + row, 1));
    // Erase to the end of the LINE, never the end of the screen: a row-level
    // erase cannot reach the rows above the viewport.
    parts.push(after ?? '', eraseLineRight());
    rewritten += 1;
  }

  parts.push(endSynchronizedOutput(), enableLineWrap());

  const output = parts.join('');
  assertViewportSafe(output);
  return { ...geometry, output, rewritten, fullRedraw };
}

/**
 * How many leading rows of the viewport have scrolled out of it.
 *
 * This is what the caller commits to the terminal's scrollback: those rows are
 * finished, they will never change, and they must be printed for real or they
 * are lost when the session ends.
 */
export function scrolledOutCount(
  previousViewportStart: number,
  nextViewportStart: number,
): number {
  return Math.max(0, nextViewportStart - previousViewportStart);
}
