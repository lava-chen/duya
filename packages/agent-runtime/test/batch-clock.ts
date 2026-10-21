/**
 * A virtual clock for the batching tests. Not a fake timer library: two numbers
 * and a sorted list of pending callbacks, so a test can move time by ten minutes
 * and every timer in the batcher fires in the order it would have fired for real.
 *
 * The plan requires this rather than a real timer ("测试用virtualclock"), and the
 * reason is concrete rather than stylistic: the slow-consumer scenario is ten
 * minutes of virtual time, and asserting on a ten-minute test is a test nobody
 * runs and everybody disables.
 */

import type { BatchClock, BatchTimer } from '../src/events/coalesce.js';

interface Scheduled {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

export interface VirtualBatchClock extends BatchClock {
  /** Move time forward, firing every timer that comes due, in order. */
  advance(ms: number): void;
  /** The current virtual time. */
  readonly current: number;
  /** Timers still armed. Zero after a window flushes. */
  pending(): number;
  /**
   * Stop firing timers, so an `advance` only moves the clock.
   *
   * Exists for one test: the `offer_expired` flush path is the defensive arm for
   * a timer that has not fired yet, and reaching it with a well-behaved clock
   * requires holding the timers back. Without this the branch could only be
   * exercised by a broken clock, which would be a test of the mock.
   */
  holdTimers(held: boolean): void;
}

export function virtualBatchClock(start = 0): VirtualBatchClock {
  let current = start;
  let seq = 0;
  let scheduled: Scheduled[] = [];
  let held = false;

  const clock: VirtualBatchClock = {
    now: () => current,
    pending: () => scheduled.length,
    holdTimers: (value: boolean) => {
      held = value;
    },
    setTimer(fn: () => void, delayMs: number): BatchTimer {
      const entry: Scheduled = { at: current + Math.max(0, delayMs), seq: seq++, fn };
      scheduled.push(entry);
      return entry;
    },
    clearTimer(timer: BatchTimer): void {
      scheduled = scheduled.filter((entry) => entry !== timer);
    },
    advance(ms: number): void {
      const target = current + ms;
      while (!held) {
        const due = scheduled
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = due[0];
        if (next === undefined) break;
        scheduled = scheduled.filter((entry) => entry !== next);
        current = next.at;
        next.fn();
      }
      current = target;
    },
  };

  // `current` is a getter over the closure variable so it tracks `advance`.
  return Object.defineProperty(clock, 'current', { get: () => current }) as VirtualBatchClock;
}
