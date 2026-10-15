/**
 * The inline viewport.
 *
 * ## The model
 *
 * The terminal is one long scrollback buffer. This TUI prints finished rows
 * into it once and never touches them again; only the rows below — the live
 * area — are rewritten each frame. Leaving the TUI therefore leaves the
 * conversation readable, which a fixed full-screen window cannot offer.
 *
 * ## The geometry that makes it work
 *
 * The bottom `chromeRows` of the screen are reserved for the composer and the
 * status bar and never scroll. Above them is the conversation region
 * (DECSTBM `1..screenRows - chromeRows`). Because that region's TOP is row 1,
 * scrolling inside it pushes row 1 into the terminal's scrollback — which is
 * precisely "commit a finished row". A region whose top is not row 1 would
 * discard the row instead, which is why the region starts at 1 and the chrome
 * is what gets carved off the bottom.
 *
 * ## What is verified and what is not
 *
 * The geometry, the windowing and the resulting byte sequences are pure
 * functions and are unit-tested here. What is NOT verified here is that a real
 * terminal interprets those sequences the way this module assumes — that needs
 * a terminal. The commit path is the one place in the inline model where being
 * wrong corrupts the user's scrollback rather than merely looking wrong, so the
 * strategy is resolved from the environment and the alternatives are named.
 */

import { assertViewportSafe, cursorTo, resetScrollRegion, setScrollRegion } from './ansi.js';

/**
 * How this terminal tolerates a scroll region.
 *
 * Windows Terminal discards rows when a partial scroll region is used, so the
 * plain region approach cannot be trusted there; `ZELLIJ` scrolls regions
 * itself. Both publish themselves to every child process, which is what makes
 * detection possible without a probe.
 */
export type ScrollbackStrategy = 'standard' | 'windows-terminal' | 'zellij';

export function detectScrollbackStrategy(env: NodeJS.ProcessEnv = process.env): ScrollbackStrategy {
  if (typeof env['ZELLIJ'] === 'string' && env['ZELLIJ'] !== '') return 'zellij';
  if (typeof env['WT_SESSION'] === 'string' && env['WT_SESSION'] !== '') return 'windows-terminal';
  return 'standard';
}

export interface TerminalSize {
  readonly rows: number;
  readonly columns: number;
}

/**
 * Where the conversation region ends and the chrome begins.
 *
 * The region always starts at row 1; that is the whole trick.
 */
export function conversationRegionBottom(size: TerminalSize, chromeRows: number): number {
  return Math.max(1, size.rows - Math.max(0, chromeRows));
}

/**
 * What the live area shows for a document of `documentRows` rows.
 *
 * `liveStart` is the 0-based index of the first row the live area owns. Rows
 * before it that are not yet committed — `overflow` of them — have to be
 * printed before the frame, because the region can only hold
 * `regionBottom` rows and the ones that fall off its bottom edge are the ones
 * that were already finished.
 *
 * When the document is shorter than the region, `liveStart` is 0 and the rows
 * below stay blank rather than being padded with filler the user would have to
 * read past.
 */
export function liveWindow(
  documentRows: number,
  committedRows: number,
  regionBottom: number,
): { readonly liveStart: number; readonly overflow: number } {
  const capacity = Math.max(1, regionBottom);
  if (documentRows <= capacity) {
    return { liveStart: 0, overflow: Math.max(0, committedRows) };
  }
  const liveStart = Math.max(committedRows, documentRows - capacity);
  return { liveStart, overflow: Math.max(0, liveStart - committedRows) };
}

export interface CommitPlan {
  /** The exact bytes to write before the next frame. Empty when nothing scrolled out. */
  readonly output: string;
  /** Rows committed by this plan. */
  readonly committed: number;
  /** The document index the live area starts at afterwards. */
  readonly liveStart: number;
}

/**
 * Plan the commit of rows that have scrolled out of the live area.
 *
 * The rows are the caller's business — they arrive already converted to ANSI,
 * because committing text that still carries tags would print `{cyan-fg}` into
 * the user's scrollback for good.
 */
export function planCommit(
  scrolledOutLines: readonly string[],
  options: {
    readonly size: TerminalSize;
    readonly chromeRows: number;
    readonly strategy: ScrollbackStrategy;
  },
): CommitPlan {
  const regionBottom = conversationRegionBottom(options.size, options.chromeRows);
  const scrolledOut = scrolledOutLines.length;

  if (scrolledOut === 0) {
    return { output: '', committed: 0, liveStart: 0 };
  }

  // Standard and Windows Terminal share this shape: write the row, then a
  // newline. Because the region ends at the bottom of the conversation area and
  // starts at row 1, that newline scrolls the region up by one and pushes row 1
  // into the terminal's scrollback.
  const writes = scrolledOutLines.map((line) => `${line}\r\n`).join('');

  // The region has to be re-asserted before scrolling and released after, or
  // the chrome scrolls with it.
  const envelope =
    options.strategy === 'zellij'
      ? writes
      : [
          setScrollRegion(1, regionBottom),
          cursorTo(regionBottom, 1),
          writes,
          cursorTo(regionBottom, 1),
          resetScrollRegion(),
        ].join('');

  assertViewportSafe(envelope);
  return {
    output: envelope,
    committed: scrolledOut,
    liveStart: scrolledOut,
  };
}
