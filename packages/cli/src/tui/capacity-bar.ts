/**
 * The one capacity bar in the CLI.
 *
 * ## Why this is a module and not three lambdas
 *
 * "How full is the window" is answered in three places — the footer's stats
 * row, the `/context` panel and the `/usage` window — and they had drifted:
 * the footer printed a bare `42%/200k` with no shape at all, `/context` printed
 * `used` / `window` / `remaining` as three unrelated numbers, and only the
 * window drew a bar. A reader learns the shape once, so it is drawn once.
 *
 * ## Why these two glyphs
 *
 * `▰` (U+25B0) and `▱` (U+25B1) are geometric shapes blessed's own width table
 * — the table that lays out every cell of this TUI, see `width.ts` — reports as
 * exactly one column, and that Windows Terminal and xterm agree on. That table
 * is not a formality: `⚡` measured 1 and Windows Terminal drew 2, which is how
 * the footer's last column got clipped (2026-10-25). Emoji-adjacent glyphs are
 * therefore out, whatever they look like in a screenshot.
 *
 * `█` / `░` would work too, and they are what minimax-code uses, but `▰`/`▱`
 * is what this CLI already drew before the footer grew a bar; introducing a
 * second vocabulary for the same reading is the thing this module exists to
 * prevent.
 *
 * ## Why a non-zero ratio always fills at least one cell
 *
 * At eight cells, `Math.round` turns every occupancy under 6% into an all-empty
 * bar printed next to `5%`, which reads as a broken widget rather than as a
 * reading. Rounding up into one cell overstates occupancy by at most one cell
 * and only in the region where the number next to it says "nearly empty"; the
 * opposite error — a bar that under-reports — is how a session walks into a
 * compaction it did not see coming.
 */

/** One filled cell. */
export const CAPACITY_FILLED = '▰';
/** One empty cell. */
export const CAPACITY_EMPTY = '▱';

/** Cell count when the caller does not ask for one. */
const DEFAULT_CELLS = 8;
/** A bar wider than this stops being a reading and starts being decoration. */
const MAX_CELLS = 24;

/**
 * Cell count the footer can afford at a given terminal width.
 *
 * Stepwise rather than proportional on purpose: a bar that grows by one cell as
 * the user drags a window edge makes the whole stats row re-flow on every
 * resize event, and a row that moves is one the eye cannot learn to skim.
 *
 * The counts are deliberately SMALL (four to six cells, never the `/usage`
 * window's eight): this bar shares one line with the token counters, the speed
 * and the model name, and the model is flush right — every cell the bar takes
 * is a column the model loses. The percentage next to it carries the precision;
 * the bar only has to carry the shape.
 */
const BAR_CELL_STEPS: ReadonlyArray<readonly [minWidth: number, cells: number]> = [
  [96, 6],
  [80, 5],
  [64, 4],
];

/**
 * How many cells the bar gets at `width`, or 0 for "no bar".
 *
 * The footer asks this; nothing else has to.
 */
export function capacityBarCellsForWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  for (const [minWidth, cells] of BAR_CELL_STEPS) {
    if (width >= minWidth) return cells;
  }
  return 0;
}

/**
 * How many of `cells` cells are filled for `ratio`.
 *
 * `ratio` is clamped to 0–1 and `null` means "nobody measured this yet", which
 * fills nothing. See the module comment for why a non-zero ratio fills at least
 * one cell.
 */
export function capacityFilledCells(ratio: number | null, cells: number): number {
  const total = normalizeCells(cells);
  if (ratio === null || !Number.isFinite(ratio)) return 0;
  const clamped = clampRatio(ratio);
  if (clamped <= 0) return 0;
  if (clamped >= 1) return total;
  // A non-zero ratio always fills at least one cell: `Math.round` turns every
  // occupancy under 1/(2·cells) into an all-empty bar printed next to `5%`,
  // which reads as a broken widget rather than a reading. See the module
  // comment.
  return Math.min(total, Math.max(1, Math.round(clamped * total)));
}

/**
 * The bar itself: `ratio` of `cells`, filled.
 *
 * No brackets and no percentage — the caller owns the surrounding text, because
 * the footer measures this string before tagging it and a caller that has to
 * strip someone else's decoration to do that will eventually get it wrong.
 */
export function capacityBar(ratio: number | null, cells = DEFAULT_CELLS): string {
  const total = normalizeCells(cells);
  if (total === 0) return '';
  const filled = capacityFilledCells(ratio, total);
  return CAPACITY_FILLED.repeat(filled) + CAPACITY_EMPTY.repeat(total - filled);
}

/** Clamp a caller-supplied cell count into something drawable. */
function normalizeCells(cells: number): number {
  if (!Number.isFinite(cells)) return 0;
  return Math.max(0, Math.min(MAX_CELLS, Math.floor(cells)));
}

/** Clamp a caller-supplied ratio into 0–1. */
function clampRatio(ratio: number): number {
  return Math.min(1, Math.max(0, ratio));
}
