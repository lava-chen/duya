/**
 * Adaptive render pacing: two gears with hysteresis.
 *
 * ## Why not a fixed throttle
 *
 * A fixed interval is wrong at both ends. On a firehose — a tool streaming a
 * large file, a long answer — it lags visibly behind the agent. On a trickle —
 * one token every few hundred milliseconds — it spends frames rendering text
 * that is visually identical to the last one.
 *
 * So the cadence is a function of the actual backlog, with two gears:
 *
 * - `normal`  — request throttled renders (see `render-scheduler.ts`).
 * - `catchUp` — the backlog is real, so stop animating and flush.
 *
 * ## Why hysteresis
 *
 * A single threshold is an oscillator. A stream hovering either side of the
 * trigger flips gear every frame, and each flip is a flush — the exact
 * expensive operation the throttle exists to avoid. Entering and exiting
 * therefore use DIFFERENT thresholds (3 lines/100ms in, 1 line/40ms out), and
 * leaving additionally requires the quiet condition to hold for a dwell
 * period.
 *
 * Re-entry after leaving is separately cooldowned, because a stream that
 * oscillates between "one line" and "four lines" would otherwise re-enter
 * catch-up on every brief spike and pay the flush each time.
 *
 * ## What is tuned vs. what is inherited
 *
 * These thresholds are REASONED for blessed, not copied. The reference this
 * was ported from assumes an 8.33ms Rust cell pipeline, where a render is
 * cheap and a flush is cheap too. Blessed's `screen.render()` re-walks every
 * element and re-parses their content, so here a flush is expensive enough to
 * be worth avoiding and each gear boundary sits further out than it would in
 * the reference.
 */

/** The two rendering gears. */
export type Gear = 'normal' | 'catchUp';

/**
 * What the caller should do with this observation.
 *
 * - `flush` — a gear TRANSITION into catch-up. Commit the entire backlog in
 *   one render rather than draining it at the render interval, because at this
 *   point the backlog is already visible to the user as lag.
 * - `catchUp` — already in catch-up; keep committing aggressively.
 * - `throttled` — normal gear; go through the scheduler.
 */
export type PacingSignal = 'flush' | 'catchUp' | 'throttled';

export interface PacerOptions {
  /** Backlog lines that force catch-up. */
  readonly enterLines?: number;
  /** Backlog age (ms) that forces catch-up regardless of line count. */
  readonly enterAgeMs?: number;
  /** Backlog must be at or under this many lines to begin leaving catch-up. */
  readonly exitLines?: number;
  /** Backlog must be at or under this age (ms) to begin leaving catch-up. */
  readonly exitAgeMs?: number;
  /** How long the quiet condition must hold before leaving catch-up. */
  readonly exitHoldMs?: number;
  /** Minimum time in normal gear before catch-up may be re-entered. */
  readonly cooldownMs?: number;
  /** Lines that bypass the cooldown entirely. */
  readonly severeLines?: number;
  /** Age (ms) that bypasses the cooldown entirely. */
  readonly severeAgeMs?: number;
}

/**
 * Defaults, with the reasoning each number carries.
 *
 * `enterLines: 3` — three unrendered lines is roughly one visual row of lag at
 * typical terminal heights: past that the user perceives the transcript as
 * behind rather than as settled. `enterAgeMs: 100` catches the single slow
 * line that never reaches three lines: at 100ms a pending fragment is also
 * past the staleness bound in `delta-buffer.ts`, so this gear change and that
 * one agree about when a quiet fragment is no longer "in flight".
 *
 * `exitLines: 1` / `exitAgeMs: 40` — deliberately far below the enter
 * thresholds. That gap IS the hysteresis. 40ms rather than 100ms because a
 * backlog that is still growing after 40ms was not a transient spike.
 *
 * `exitHoldMs: 250` — long enough that one more tool call or one more sentence
 * does not drop back out of catch-up and into a lagging throttle.
 *
 * `cooldownMs: 250`, matching the dwell, so the two ends of the oscillation
 * are symmetric in time rather than asymmetric in cost.
 *
 * `severeLines: 32` / `severeAgeMs: 300` — roughly a screenful of backlog, or
 * a third of a second of visible lag. Past this, staying in a throttle that is
 * knowingly too slow is worse than the cost of the flush it is avoiding.
 */
const DEFAULTS = {
  enterLines: 3,
  enterAgeMs: 100,
  exitLines: 1,
  exitAgeMs: 40,
  exitHoldMs: 250,
  cooldownMs: 250,
  severeLines: 32,
  severeAgeMs: 300,
} as const;

export class Pacer {
  private gear: Gear = 'normal';
  private lowSince: number | null = null;
  /**
   * When catch-up was last LEFT, or -Infinity.
   *
   * Measured from the EXIT, not the entry — and that is not a detail. The
   * dwell below is 250ms and the cooldown is 250ms, so a cooldown measured
   * from entry has always elapsed by the time the gear can change at all, and
   * the rule would be dead code that reads as if it were doing something.
   */
  private lastExitAt = Number.NEGATIVE_INFINITY;
  private readonly o: Required<PacerOptions>;

  constructor(options: PacerOptions = {}) {
    this.o = { ...DEFAULTS, ...options };
  }

  /** The gear currently engaged. Read by tests and the status bar. */
  get currentGear(): Gear {
    return this.gear;
  }

  /**
   * Feed the current backlog and get the pacing decision.
   *
   * @param queuedLines   lines committed to the model but not yet rendered.
   * @param oldestQueuedAgeMs  age of the oldest such line.
   * @param now           current time on the injected clock.
   */
  observe(queuedLines: number, oldestQueuedAgeMs: number, now: number): PacingSignal {
    if (this.gear === 'catchUp') {
      const quiet = queuedLines <= this.o.exitLines && oldestQueuedAgeMs <= this.o.exitAgeMs;
      if (!quiet) {
        this.lowSince = null;
        return 'catchUp';
      }
      // Quiet, but quiet has to PERSIST. Starting the clock on the first
      // quiet observation is what separates a transient lull from an
      // exhausted backlog.
      if (this.lowSince === null) {
        this.lowSince = now;
        return 'catchUp';
      }
      if (now - this.lowSince >= this.o.exitHoldMs) {
        this.gear = 'normal';
        this.lowSince = null;
        this.lastExitAt = now;
        return 'throttled';
      }
      return 'catchUp';
    }

    const wantsCatchUp = queuedLines >= this.o.enterLines || oldestQueuedAgeMs >= this.o.enterAgeMs;
    if (!wantsCatchUp) return 'throttled';

    const severe = queuedLines >= this.o.severeLines || oldestQueuedAgeMs >= this.o.severeAgeMs;
    if (!severe && now - this.lastExitAt < this.o.cooldownMs) return 'throttled';

    this.gear = 'catchUp';
    this.lowSince = null;
    return 'flush';
  }

  /** Return to `normal`, e.g. at the end of a turn. */
  reset(): void {
    this.gear = 'normal';
    this.lowSince = null;
    this.lastExitAt = Number.NEGATIVE_INFINITY;
  }
}
