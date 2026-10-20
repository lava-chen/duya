/**
 * The visible window of a tall document.
 *
 * ## One query, two consumers
 *
 * Full-screen mode slices the transcript to the pane; inline mode has to decide
 * which rows are old enough to commit to the terminal's scrollback and which
 * must stay live. Those look like different problems and were solved in
 * different places (`paintTranscript` vs `InlineSurface.render({ viewEnd })`),
 * which is how they came to disagree about what "scrolled back" means.
 *
 * They are the same question: given per-block heights, a viewport and a scroll
 * offset, which lines are on screen? So it is asked once, here, and both modes
 * read the answer.
 *
 * ## Follow is an offset, not a flag
 *
 * `scrollLines === 0` means "the newest line is visible", because the window
 * ends at the last line and only ever drops lines from the top. Deriving follow
 * from the offset is what makes "I scrolled to the bottom but it still says
 * paused" unreachable — there is no second piece of state to get out of sync.
 */

/** Where a scroll offset puts the viewport, in both line and block terms. */
export interface VisibleWindow {
  /** Every line in the document. */
  readonly totalLines: number;
  /** The largest legal `lineStart` — the offset that shows the last line. */
  readonly maxStart: number;
  /** First visible line, 0-based, in document coordinates. */
  readonly lineStart: number;
  /** One past the last visible line. */
  readonly lineEnd: number;
  /** First block intersecting the window. */
  readonly firstBlock: number;
  /** One past the last block intersecting the window. */
  readonly lastBlock: number;
  /** True when the newest line is on screen. */
  readonly following: boolean;
}

/**
 * Resolve the window.
 *
 * `scrollLines` is how far BACK from the newest line the reader has scrolled,
 * clamped to the document: a scroll past the top shows the top, and no scroll
 * means follow. An empty document yields an empty window rather than a
 * one-line one, so a caller cannot paint a line that does not exist.
 */
export function visibleWindow(
  heights: readonly number[],
  viewportRows: number,
  scrollLines: number,
): VisibleWindow {
  const rows = Math.max(1, Math.floor(viewportRows));
  let totalLines = 0;
  for (const height of heights) totalLines += Math.max(0, height);

  const maxStart = Math.max(0, totalLines - rows);
  const offset = Math.min(maxStart, Math.max(0, Math.floor(scrollLines)));
  const lineStart = maxStart - offset;
  const lineEnd = Math.min(totalLines, lineStart + rows);

  return {
    totalLines,
    maxStart,
    lineStart,
    lineEnd,
    firstBlock: blockAt(heights, lineStart),
    lastBlock: blockAfter(heights, lineEnd),
    following: offset === 0,
  };
}

/** Index of the block containing `line`, or the block count when past the end. */
function blockAt(heights: readonly number[], line: number): number {
  let cursor = 0;
  for (const [index, height] of heights.entries()) {
    cursor += Math.max(0, height);
    if (line < cursor) return index;
  }
  return heights.length;
}

/**
 * One past the last block that starts before `line`.
 *
 * A zero-height block is never "before" anything, so it is skipped rather than
 * counted — otherwise an empty block at the fold would drag one more block into
 * the paint for no visible reason.
 */
function blockAfter(heights: readonly number[], line: number): number {
  let cursor = 0;
  let last = 0;
  for (const [index, height] of heights.entries()) {
    const size = Math.max(0, height);
    if (size === 0) continue;
    if (cursor >= line) break;
    cursor += size;
    last = index + 1;
  }
  return last;
}
