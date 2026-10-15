/**
 * Trailing-edge render throttle.
 *
 * ## Why throttle at all
 *
 * See `delta-buffer.ts`: one `screen.render()` is O(screen area) because
 * blessed re-walks every element. Rendering once per token makes the render
 * loop, not the agent, the thing that determines how fast the CLI feels.
 *
 * ## Why trailing-edge and not leading-edge
 *
 * Leading-edge (render now, then swallow everything for `minIntervalMs`) drops
 * the tail of a stream: the last delta before a `done` never gets a frame, so
 * the final characters of an answer can be missing until the next event. On a
 * fast burst the output also stops tracking the agent entirely.
 *
 * Trailing-edge renders the LAST state in each interval, which is always the
 * complete one. Input latency is paid for instead, and immediately: keyboard
 * input routes through `requestImmediate()` rather than queueing behind a
 * timer, because a queued `setTimeout` on Windows can cost a full tick of
 * perceived lag on the one interaction where lag is felt most.
 *
 * ## Why the clock and timers are injected
 *
 * So the throttle can be tested as a function of state with no TTY and no
 * real waiting. `performance.now()` and fake timers do not agree about what
 * they advance, and a throttle tested against the real clock is a throttle
 * tested against the machine's mood.
 */

/** Opaque timer handle, so tests can supply their own scheduler. */
export type TimerHandle = unknown;

/**
 * Minimum gap between two renders, in ms.
 *
 * 70ms is ~14fps. The choice is a blend: fast enough that a token stream
 * still reads as continuous typing, slow enough that a firehose spends the
 * large majority of its time waiting rather than inside blessed's re-walk. The
 * reference implementation this was ported from assumes an 8.33ms Rust cell
 * pipeline; blessed's per-render cost is far higher, so matching its cadence
 * here would simply move the bottleneck, and matching nothing would let the
 * render loop dominate. This is reasoned rather than measured on this machine,
 * and it is the single constant most worth revisiting after real use.
 */
export const MIN_RENDER_INTERVAL_MS = 70;

export interface RenderSchedulerOptions {
  /** Minimum gap between renders. Defaults to `MIN_RENDER_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** Monotonic clock, injected for tests. Defaults to `performance.now()`. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** Performs the actual render. Called at most once per interval. */
  readonly onRender: () => void;
}

export class RenderScheduler {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly onRender: () => void;

  private timer: TimerHandle | undefined;
  private renderRequested = false;
  /** Negative infinity, so the FIRST request renders on the next tick at delay 0. */
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private renders = 0;

  constructor(options: RenderSchedulerOptions) {
    this.minIntervalMs = options.minIntervalMs ?? MIN_RENDER_INTERVAL_MS;
    this.now = options.now ?? (() => performance.now());
    this.setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onRender = options.onRender;
  }

  /** Renders performed so far. Observability, and what the tests assert on. */
  get renderCount(): number {
    return this.renders;
  }

  /** True when a trailing render is queued. */
  get hasPendingRender(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Ask for a render, coalescing into at most one per interval.
   *
   * Safe to call once per token: the common case is a flag assignment, and no
   * timer is even created once one is already pending.
   */
  request(): void {
    this.renderRequested = true;
    if (this.timer !== undefined || this.stopped) return;

    const elapsed = this.now() - this.lastRenderAt;
    const delay = Math.max(0, this.minIntervalMs - elapsed);

    this.timer = this.setTimer(() => {
      this.timer = undefined;
      // Cleared BEFORE the render so a render that itself requests another
      // render (content height changed) schedules the next interval rather
      // than being swallowed by the one that is already running.
      this.renderRequested = false;
      this.render();
      this.lastRenderAt = this.now();
      if (this.renderRequested) this.request();
    }, delay);
  }

  /**
   * Render now, cancelling anything queued.
   *
   * Every keyboard event routes here. Queueing input behind a throttled frame
   * would make typing feel like the render loop is deciding how fast the user
   * may type.
   */
  requestImmediate(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.renderRequested = false;
    this.render();
    this.lastRenderAt = this.now();
  }

  /**
   * Stop scheduling renders.
   *
   * Distinct from `requestImmediate` on purpose: teardown must also cancel the
   * queued timer, or a render fires into a destroyed screen.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.renderRequested = false;
  }

  private render(): void {
    this.renders += 1;
    this.onRender();
  }
}
