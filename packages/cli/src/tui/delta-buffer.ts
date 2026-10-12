/**
 * The pending-delta buffer: where stream tokens go so that no render happens
 * per token.
 *
 * ## The failure this exists to prevent
 *
 * Blessed's `screen.render()` re-walks every attached element
 * (`node_modules/blessed/lib/widgets/screen.js:735`) and each element re-parses
 * its whole content and rewrites every cell in its region
 * (`element.js:1836`). The cell diff against the cached grid is cheap; the
 * re-walk is not. Cost per call is O(screen area) no matter how little changed.
 * A model that streams a 4,000-token answer at one render per token spends
 * essentially its entire time budget inside blessed, and the terminal — which
 * is the thing being drawn — gets whatever is left.
 *
 * So: deltas are appended here and nothing is rendered. This class is the
 * buffer, and its second job is to decide WHEN the buffered text becomes
 * visible.
 *
 * ## Line quantisation
 *
 * The rule is one line: commit a pending fragment when it contains a newline,
 * OR when the OLDEST pending fragment has gone stale. Concretely, "animate
 * lines, not tokens" — a paragraph appearing row by row reads as output
 * arriving, while a paragraph appearing character by character reads as a
 * flickering glitch.
 *
 * The staleness clause is what keeps the rule honest. A single long line with
 * no newline in it would otherwise never appear at all, which is worse than
 * late: the user types a prompt, presses Enter, and sees no evidence the agent
 * is working. `STALE_MS` bounds that worst case.
 */

/** Default bound on how long a newline-less fragment may stay invisible. */
export const DEFAULT_STALE_MS = 120;

/** What `take` reports when there is nothing ready to commit. */
const NOT_READY = '';

export interface DeltaBufferOptions {
  /**
   * How long the oldest pending fragment may wait before being committed
   * anyway. One visible-tick budget is enough; see the module comment for why
   * this clause has to exist at all.
   */
  readonly staleMs?: number;
}

export class DeltaBuffer {
  private pending = '';
  /**
   * When the currently-buffered text's FIRST fragment arrived, or -1 when
   * nothing is buffered. This is the age the staleness rule measures: a
   * fragment that has been sitting for `staleMs` has been sitting since it
   * started, not since it was last appended to.
   */
  private pendingSince = -1;
  private readonly staleMs: number;

  constructor(options: DeltaBufferOptions = {}) {
    const stale = options.staleMs ?? DEFAULT_STALE_MS;
    if (!Number.isFinite(stale) || stale < 0) {
      throw new RangeError(`staleMs must be a non-negative finite number, got ${stale}`);
    }
    this.staleMs = stale;
  }

  /** Characters currently buffered and not yet committed. */
  get pendingLength(): number {
    return this.pending.length;
  }

  /** True when nothing is buffered. */
  get isEmpty(): boolean {
    return this.pending.length === 0;
  }

  /**
   * Age of the oldest pending fragment in ms, or 0 when nothing is pending.
   * The adaptive pacer reads this to decide whether the backlog is a firehose
   * or a trickle.
   */
  oldestPendingAge(now: number): number {
    if (this.pendingSince < 0) return 0;
    return Math.max(0, now - this.pendingSince);
  }

  /**
   * Append streamed text. Never renders, never mutates the block model.
   *
   * Empty appends are ignored rather than treated as a flush, so a provider
   * that emits empty delta frames (the engine does skip empty text, but the
   * frame type still reaches the CLI) cannot reset the staleness clock and
   * starve the staleness clause.
   */
  append(text: string, now: number): void {
    if (text.length === 0) return;
    if (this.pending.length === 0) {
      this.pendingSince = now;
    }
    this.pending += text;
  }

  /**
   * Return the text that is ready to be committed to the block model, or `''`
   * when nothing is ready.
   *
   * When a newline is present, only the portion UP TO AND INCLUDING the last
   * newline is returned. The tail after it stays buffered, because it is the
   * start of the next line and it is still growing — committing it would put a
   * half-written line in front of the reader and then rewrite it.
   *
   * Consuming a commit resets the staleness clock for whatever remains, which
   * is what makes a long paragraph stream steadily rather than all at once.
   */
  take(now: number): string {
    if (this.pending.length === 0) return NOT_READY;

    const lastNewline = this.pending.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const ready = this.pending.slice(0, lastNewline + 1);
      this.pending = this.pending.slice(lastNewline + 1);
      this.pendingSince = this.pending.length === 0 ? -1 : now;
      return ready;
    }

    if (this.pendingSince >= 0 && now - this.pendingSince >= this.staleMs) {
      const ready = this.pending;
      this.pending = '';
      this.pendingSince = -1;
      return ready;
    }

    return NOT_READY;
  }

  /**
   * Commit everything buffered regardless of the rules. For turn boundaries,
   * where leaving a partial line invisible would make the transcript disagree
   * with what actually happened.
   */
  flush(): string {
    const ready = this.pending;
    this.pending = '';
    this.pendingSince = -1;
    return ready;
  }

  /** Drop everything uncommitted. For `/clear` and turn resets. */
  reset(): void {
    this.pending = '';
    this.pendingSince = -1;
  }
}
