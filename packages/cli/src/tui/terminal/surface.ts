/**
 * The inline surface: the write path for a TUI that does not own the screen.
 *
 * ## What it does with a frame
 *
 * A frame has two regions. The CONVERSATION is one long document — rows that
 * scroll off its top are COMMITTED, printed for real so they join the terminal's
 * scrollback, then forgotten. The CHROME is the composer, the popup and the
 * status bar, bottom-anchored, never scrolled and never committed. Only the
 * rows below the last committed one are the live area, and of those only the
 * ones that changed are rewritten.
 *
 * The split is not tidiness. Committed text becomes the terminal's property the
 * moment it is printed, and the composer becoming terminal property would take
 * the input box away from the user.
 *
 * ## The one constraint that shapes everything
 *
 * **A committed row can never be un-committed.** That is what the terminal's
 * scrollback means, and it has an exact consequence: commits may only ever
 * ADVANCE. Two rules follow, and both are enforced here rather than trusted to
 * the caller:
 *
 * 1. Rows are committed ONLY while the view is following the tail. A row the
 *    user has scrolled away from may be wanted again, and the terminal cannot
 *    be told to take it back.
 * 2. The live area starts at or after the committed boundary. It will not
 *    repaint a row that is already in the scrollback, because that row would
 *    then exist twice.
 *
 * Rule 2 has a visible consequence, and it is the honest one: scrolling back
 * further than the uncommitted tail cannot show older text here, because that
 * text is no longer on this screen. `render` reports `atBoundary` so the caller
 * can say so in the status bar and point the user at the terminal's own
 * scrollback.
 *
 * Encoding this as arithmetic rather than as an assertion is deliberate. The
 * failure being prevented — a negative overflow, or a live area starting behind
 * the committed boundary — produces duplicated or blanked rows, and both read as
 * "the TUI is broken" rather than "the model scrolled back too far".
 *
 * ## Blank rows are not free
 *
 * When the live document is shorter than the screen, the rows below it are
 * blanked rather than left holding whatever the shell had. A shorter frame is
 * the normal case right after a `/clear`, and leaving stale pixels there would
 * look exactly like a rendering bug.
 */

import { cursorTo as cursorToSequence, hideCursor, showCursor } from './ansi.js';
import { renderViewportFrame } from './diff.js';
import { lineToAnsi } from './line.js';
import type { SceneLine } from '../core/span.js';
import {
  conversationRegionBottom,
  detectScrollbackStrategy,
  liveWindow,
  planCommit,
  type ScrollbackStrategy,
  type TerminalSize,
} from './viewport.js';

export interface InlineSurfaceOptions {
  readonly output: NodeJS.WritableStream;
  readonly size: () => TerminalSize;
  /** Defaults to detection from `process.env`. */
  readonly strategy?: ScrollbackStrategy;
  /**
   * How many live areas' worth of conversation to keep uncommitted.
   *
   * This is a straight trade, and the default takes the side that cannot lose
   * text. Commits print rows into the terminal's scrollback, permanently. If a
   * row is held rather than committed, it is on no screen at all until the user
   * scrolls back to it — so raising this creates scroll-back range by creating a
   * stretch of transcript that is printed nowhere, and that a user who never
   * scrolls will simply never see.
   *
   * `1` — commit the moment a row leaves the live area — leaves no gap and
   * nothing unwritten. `2` or more buys app-scrolled history at the cost of that
   * gap. Default `1`, because silently missing text is worse than scrolling with
   * the terminal, which is where the history is anyway.
   */
  readonly reserve?: number;
}

/** Default held rows, in screens' worth of the live area. */
const COMMIT_RESERVE_SCREENS = 1;

export interface InlineFrameResult {
  /** Rows committed to scrollback by this frame. */
  readonly committed: number;
  /** Rows rewritten in the live area. */
  readonly rewritten: number;
  /**
   * The view asked for rows that are already in the scrollback, so the live
   * area is pinned to its oldest uncommitted row. Older text than that is only
   * reachable through the terminal's own scrollback.
   */
  readonly atBoundary: boolean;
}

export interface InlineFrame {
  /**
   * The conversation, unbounded and in transcript order. Rows that scroll off
   * its top are committed to the terminal's scrollback, which is why this is not
   * pre-windowed: windowing it here would make "what scrolled off" unknowable.
   */
  readonly scroll: readonly SceneLine[];
  /**
   * Composer, popup and status, bottom-anchored and never scrolled. Kept
   * separate from `scroll` for two reasons: it must not be committed, and the
   * slack between a short `scroll` and the bottom of the screen has to be blank
   * rows ABOVE it, not below.
   */
  readonly chrome: readonly SceneLine[];
  /** Caret: a row index in scroll or chrome and a 1-based column, or null. */
  readonly caret: {
    readonly row: number;
    readonly column: number;
    /** Chrome coordinates include padding above the bottom-anchored composer. */
    readonly region?: 'chrome';
  } | null;
  /**
   * One past the last `scroll` row the user wants visible. Omit to follow the
   * tail, which is the only mode that commits.
   */
  readonly viewEnd?: number;
}

export class InlineSurface {
  readonly #output: NodeJS.WritableStream;
  readonly #size: () => TerminalSize;
  readonly #strategy: ScrollbackStrategy;
  readonly #reserve: number;

  /** Document index that owns live-area row 1. Only ever advances. */
  #liveStart = 0;
  #previousLive: string[] = [];
  #previousCapacity = 0;
  #started = false;

  constructor(options: InlineSurfaceOptions) {
    this.#output = options.output;
    this.#size = options.size;
    this.#strategy = options.strategy ?? detectScrollbackStrategy();
    this.#reserve = Math.max(1, options.reserve ?? COMMIT_RESERVE_SCREENS);
  }

  /** Document rows already printed into the terminal's scrollback. */
  get committedRows(): number {
    return this.#liveStart;
  }

  /** Repaint the live viewport after another surface borrowed the terminal. */
  invalidate(): void {
    this.#previousLive = [];
    this.#started = false;
  }

  /**
   * Show one frame: `scroll` windowed and committed, `chrome` pinned to the
   * bottom, caret placed.
   *
   * The commit is deliberately outside the frame's synchronized-output envelope
   * (`renderViewportFrame` owns that). It is a scroll of the conversation
   * region, which is exactly the operation the terminal performs for ordinary
   * output; wrapping it would mean opening synchronized output here and relying
   * on the frame's own terminator to close it, and a terminator that is never
   * reached leaves the terminal swallowing everything it is sent.
   */
  render(frame: InlineFrame): InlineFrameResult {
    const size = this.#size();
    const capacity = Math.max(1, conversationRegionBottom(size, 0));
    // A composer taller than the screen is a terminal too small to have both.
    // Chrome wins, because a status line the user cannot see is a bug and a
    // truncated conversation is a view. Clamping to `capacity` rather than to
    // `capacity - 1` is deliberate: the conversation may get zero rows, and a
    // forced minimum of one would build a frame one row taller than the screen.
    const chrome = frame.chrome.slice(0, capacity);
    const liveRows = Math.max(0, capacity - chrome.length);
    const scroll = frame.scroll;

    // A document SHORTER than what has been committed was replaced rather than
    // appended to — a `/clear`. Its old rows are still in the terminal's
    // scrollback and cannot be taken back, but they are no longer part of this
    // document, so the live area restarts at row 0. Keeping the old offset would
    // leave the new conversation invisible behind rows that no longer exist,
    // which is what a `/clear` followed by an empty-looking screen looks like.
    if (scroll.length < this.#liveStart) {
      this.#liveStart = 0;
      this.#previousLive = [];
    }

    const following = frame.viewEnd === undefined;
    // Clamped into the document rather than trusted: an out-of-range view end
    // would otherwise slice past the end and silently shorten the frame.
    const desiredEnd = following
      ? scroll.length
      : Math.max(0, Math.min(scroll.length, Math.trunc(frame.viewEnd as number)));
    const desiredStart = Math.max(0, desiredEnd - liveRows);
    // Not clamped to the committed boundary yet: committing below moves that
    // boundary, and a start computed before the commit would window the live
    // area against rows this very frame printed.
    const atBoundaryRequested = !following && desiredStart < this.#liveStart;

    let committed = 0;
    if (following && liveRows > 0) {
      // The reserve, not the live area, is what bounds the uncommitted tail.
      // Windowing against `liveRows * reserve` means the live area is still the
      // last `liveRows` rows — it is `liveWindow` that decides how far back the
      // held buffer reaches, which is the only thing that decides what PgUp can
      // still show.
      const plan = liveWindow(scroll.length, this.#liveStart, liveRows * this.#reserve);
      if (plan.overflow > 0) {
        // Converted here, not left to the caller. A committed row is written into
        // the user's scrollback PERMANENTLY, so a tag that survives the trip is
        // printed as literal `{gray-fg}` in their history and no later frame can
        // take it back. `renderViewportFrame` converts the live area on the same
        // terms.
        const rows = scroll.slice(this.#liveStart, this.#liveStart + plan.overflow).map(lineToAnsi);
        const commit = planCommit(rows, {
          size,
          chromeRows: chrome.length,
          strategy: this.#strategy,
        });
        if (commit.output !== '') this.#output.write(commit.output);
        this.#liveStart += plan.overflow;
        committed = plan.overflow;
      }
    }

    // The live area may never start behind the committed boundary: those rows are
    // already printed, and redrawing them duplicates the conversation.
    const start = Math.max(this.#liveStart, desiredStart);
    const atBoundary = atBoundaryRequested || (!following && desiredStart < start);

    const window = liveRows > 0 ? scroll.slice(start, start + liveRows) : [];
    // The slack goes ABOVE the chrome. Padding the composed document to capacity
    // instead would put blank rows under the status line, which is the one place
    // on screen that must never be blank.
    //
    // Conversion to ANSI happens HERE and only here: the diff compares the same
    // strings it writes, so a row cannot be "equal" as tags and different on
    // screen, and the inline path stops carrying a tag parser of its own.
    const slack = liveRows - window.length;
    const live = [
      ...window.map(lineToAnsi),
      ...new Array<string>(Math.max(0, slack)).fill(''),
      ...chrome.map(lineToAnsi),
    ];

    const geometry = { topRow: Math.max(1, capacity - live.length + 1), rows: capacity };
    // A resize changes both the viewport height and the row every live row sits
    // on, so nothing about the previous frame can be reused. That is judged by
    // capacity, not by document length: the live array is always padded to
    // capacity, so a length mismatch would never fire and a resize would
    // repaint the tail of the conversation into the wrong rows.
    const resized = this.#started && this.#previousCapacity !== capacity;
    const painted = renderViewportFrame(this.#started ? this.#previousLive : [], live, geometry, {
      forceFullRedraw: resized,
    });

    this.#output.write(painted.output);
    this.#previousLive = live;
    this.#previousCapacity = capacity;
    this.#started = true;

    if (frame.caret === null) {
      this.#output.write(hideCursor());
    } else {
      // The caret row is an index into `scroll`, so the row it lands on is that
      // offset inside the composed document. The column is the editor's own,
      // not a recomputed one: the caret sits inside the text the user typed.
      const row = geometry.topRow + (frame.caret.region === 'chrome'
        ? liveRows + frame.caret.row
        : frame.caret.row - start);
      if (row >= geometry.topRow && row < geometry.topRow + capacity) {
        this.#output.write(cursorToSequence(row, frame.caret.column));
        this.#output.write(showCursor());
      }
    }

    return { committed, rewritten: painted.rewritten, atBoundary };
  }

  /** Release the terminal. Nothing is erased — the conversation stays. */
  stop(): void {
    this.#output.write(showCursor());
    this.#started = false;
    this.#previousLive = [];
    this.#previousCapacity = 0;
  }
}
