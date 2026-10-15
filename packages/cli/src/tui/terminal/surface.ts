/**
 * The inline surface: the write path for a TUI that does not own the screen.
 *
 * ## What it does with a frame
 *
 * The frame is one logical document — transcript, popup, composer, status —
 * as an array of rows. Rows that have scrolled off the top are COMMITTED:
 * printed for real so they join the terminal's scrollback, then forgotten.
 * The rows that remain are the live area, bottom-aligned to the screen, and
 * only the ones that changed are rewritten.
 *
 * ## The one constraint that shapes everything
 *
 * **A committed row can never be un-committed.** That is what the terminal's
 * scrollback means, and it has an exact consequence: commits may only ever
 * ADVANCE. So when the user scrolls back through the transcript, the live area
 * is redrawn in place and nothing is committed, because the document it is
 * looking at is not a suffix of the one it was looking at before.
 *
 * Encoding that as an assertion is the point of this class. The alternative —
 * letting the arithmetic produce a negative overflow and writing it — is how a
 * TUI ends up printing rows twice or clobbering history.
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
}

export interface InlineFrameResult {
  /** Rows committed to scrollback by this frame. */
  readonly committed: number;
  /** Rows rewritten in the live area. */
  readonly rewritten: number;
}

export class InlineSurface {
  readonly #output: NodeJS.WritableStream;
  readonly #size: () => TerminalSize;
  readonly #strategy: ScrollbackStrategy;

  /** Document index that owns live-area row 1. Only ever advances. */
  #liveStart = 0;
  #previousLive: string[] = [];
  #started = false;

  constructor(options: InlineSurfaceOptions) {
    this.#output = options.output;
    this.#size = options.size;
    this.#strategy = options.strategy ?? detectScrollbackStrategy();
  }

  /** Document rows already printed into the terminal's scrollback. */
  get committedRows(): number {
    return this.#liveStart;
  }

  /**
   * Show `document`, committing whatever has scrolled out of the live area.
   *
   * `cursor` is where the editor's caret belongs, as a document row index;
   * `null` hides the cursor.
   */
  render(document: readonly string[], cursor: number | null): InlineFrameResult {
    const size = this.#size();
    const regionBottom = conversationRegionBottom(size, 0);
    const capacity = Math.max(1, regionBottom);

    // A previous frame taller than the current screen is the resize case: the
    // live area moved, so every row has to be rewritten.
    const resized = this.#started && this.#previousLive.length !== Math.min(document.length, capacity);

    const plan = liveWindow(document.length, this.#liveStart, capacity);
    let committed = 0;
    if (plan.overflow > 0) {
      const rows = document.slice(this.#liveStart, this.#liveStart + plan.overflow);
      const commit = planCommit(rows, {
        size,
        chromeRows: 0,
        strategy: this.#strategy,
      });
      if (commit.output !== '') this.#output.write(commit.output);
      this.#liveStart += plan.overflow;
      committed = plan.overflow;
    }

    const live = document.slice(this.#liveStart, this.#liveStart + capacity);
    // Blank the rows the document no longer reaches, so a `/clear` does not
    // leave the previous conversation on screen.
    while (live.length < capacity) live.push('');

    const geometry = {
      topRow: Math.max(1, regionBottom - live.length + 1),
      rows: capacity,
    };
    const frame = renderViewportFrame(this.#started && !resized ? this.#previousLive : [], live, geometry, {
      forceFullRedraw: !this.#started || resized,
    });

    this.#output.write(frame.output);
    this.#previousLive = live;
    this.#started = true;

    if (cursor === null) {
      this.#output.write(hideCursor());
    } else {
      const row = geometry.topRow + (cursor - this.#liveStart);
      if (row >= geometry.topRow && row < geometry.topRow + capacity) {
        this.#output.write(cursorToSequence(row, 1));
        this.#output.write(showCursor());
      }
    }

    return { committed, rewritten: frame.rewritten };
  }

  /** Release the terminal. Nothing is erased — the conversation stays. */
  stop(): void {
    this.#output.write(showCursor());
    this.#started = false;
    this.#previousLive = [];
  }
}
