import { describe, it, expect, vi } from 'vitest';
import { RenderScheduler, MIN_RENDER_INTERVAL_MS } from '../ui/render-scheduler.js';

/**
 * A clock the test drives by hand.
 *
 * Deliberately not `vi.useFakeTimers()`: the scheduler takes its clock and
 * timers as INJECTED dependencies precisely so that "what time is it" and
 * "when does the timer fire" cannot disagree, which is exactly the confusion
 * fake timers invite. Here, `advance` runs a timer at its own due time and
 * moves `now` to that moment, so the scheduler observes the same instant the
 * timer fired.
 */
class FakeClock {
  now = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Move time forward, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      this.now = dueAt;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      timer?.fn();
    }
    this.now = target;
  }
}

function makeScheduler(clock: FakeClock, onRender: () => void, minIntervalMs?: number) {
  return new RenderScheduler({
    onRender,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
  });
}

describe('RenderScheduler', () => {
  it('collapses a token storm into one render', () => {
    const clock = new FakeClock();
    const renders: number[] = [];
    const scheduler = makeScheduler(clock, () => renders.push(clock.now));

    // 1000 "tokens" arriving in the same tick: the shape a firehose has.
    for (let i = 0; i < 1000; i += 1) scheduler.request();

    expect(renders).toHaveLength(0);

    clock.advance(MIN_RENDER_INTERVAL_MS);
    expect(renders).toHaveLength(1);
  });

  it('renders the LAST state in an interval rather than the first', () => {
    const clock = new FakeClock();
    let seen = 0;
    const scheduler = makeScheduler(clock, () => {
      seen = seen + 1;
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    clock.advance(MIN_RENDER_INTERVAL_MS);
    expect(seen).toBe(1);
  });

  it('keeps rendering while requests continue to arrive', () => {
    const clock = new FakeClock();
    const scheduler = makeScheduler(clock, () => {});
    scheduler.request();

    // One request per interval for ten intervals.
    for (let i = 0; i < 10; i += 1) {
      clock.advance(MIN_RENDER_INTERVAL_MS);
      scheduler.request();
    }
    clock.advance(MIN_RENDER_INTERVAL_MS);

    // A throttle that stops rendering would strand the tail of a stream.
    expect(scheduler.renderCount).toBeGreaterThanOrEqual(10);
  });

  it('renders immediately for keyboard input, cancelling the queued render', () => {
    const clock = new FakeClock();
    const scheduler = makeScheduler(clock, () => {});

    scheduler.request();
    expect(scheduler.hasPendingRender).toBe(true);

    scheduler.requestImmediate();

    // The queued render is cancelled, not merely preceded: a keystroke must
    // not cause a second frame a tick later.
    expect(scheduler.hasPendingRender).toBe(false);
    expect(scheduler.renderCount).toBe(1);
  });

  it('does not render after stop()', () => {
    const clock = new FakeClock();
    const scheduler = makeScheduler(clock, () => {});
    scheduler.request();
    scheduler.stop();

    clock.advance(MIN_RENDER_INTERVAL_MS * 4);

    expect(scheduler.renderCount).toBe(0);
  });

  it('requestImmediate after stop() is a no-op', () => {
    const clock = new FakeClock();
    const scheduler = makeScheduler(clock, () => {});
    scheduler.stop();
    scheduler.requestImmediate();
    expect(scheduler.renderCount).toBe(0);
  });
});
