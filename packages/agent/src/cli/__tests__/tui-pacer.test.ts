import { describe, it, expect } from 'vitest';
import { Pacer } from '../ui/pacer.js';

/**
 * The pacer is a state machine over `{queuedLines, oldestQueuedAgeMs}`, so
 * every case here is a table walk rather than a timing test. `now` is an
 * argument, not a clock read, which is what makes the hysteresis testable at
 * all: the dwell and the cooldown are expressed in the inputs.
 */
describe('Pacer', () => {
  it('stays throttled below the enter threshold', () => {
    const pacer = new Pacer();
    expect(pacer.observe(0, 0, 0)).toBe('throttled');
    expect(pacer.observe(2, 10, 10)).toBe('throttled');
    expect(pacer.currentGear).toBe('normal');
  });

  it('enters catch-up at the line threshold and flushes', () => {
    const pacer = new Pacer();
    expect(pacer.observe(3, 0, 0)).toBe('flush');
    expect(pacer.currentGear).toBe('catchUp');
  });

  it('enters catch-up on age alone, even with one line', () => {
    const pacer = new Pacer();
    expect(pacer.observe(1, 100, 0)).toBe('flush');
    expect(pacer.currentGear).toBe('catchUp');
  });

  it('holds catch-up until quiet AND the dwell has elapsed', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);

    // Quiet at t=0 STARTS the dwell; it does not satisfy it. This is the
    // difference between a dwell and a single-sample exit.
    expect(pacer.observe(0, 0, 0)).toBe('catchUp');
    expect(pacer.currentGear).toBe('catchUp');

    expect(pacer.observe(0, 0, 100)).toBe('catchUp');
    expect(pacer.currentGear).toBe('catchUp');

    expect(pacer.observe(0, 0, 250)).toBe('throttled');
    expect(pacer.currentGear).toBe('normal');
  });

  it('resets the dwell when the backlog returns mid-dwell', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);
    pacer.observe(0, 0, 0);

    // A backlog well above the quiet threshold restarts the dwell, so the
    // dwell cannot be satisfied by two quiet samples separated by a burst.
    expect(pacer.observe(5, 0, 100)).toBe('catchUp');
    expect(pacer.observe(0, 0, 200)).toBe('catchUp');
    expect(pacer.observe(0, 0, 300)).toBe('catchUp');
    expect(pacer.currentGear).toBe('catchUp');
    expect(pacer.observe(0, 0, 460)).toBe('throttled');
  });

  it('blocks re-entry until the cooldown elapses', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0); // enter
    pacer.observe(0, 0, 0);
    pacer.observe(0, 0, 250); // exit at t=250
    expect(pacer.currentGear).toBe('normal');

    // The cooldown runs from the EXIT, so a spike right after leaving must
    // not re-enter. Measured from the entry it could never block anything:
    // the dwell is 250ms, so 250ms after entry is always in the past.
    expect(pacer.observe(4, 0, 300)).toBe('throttled');
    expect(pacer.currentGear).toBe('normal');

    // Past the cooldown it may.
    expect(pacer.observe(4, 0, 520)).toBe('flush');
    expect(pacer.currentGear).toBe('catchUp');
  });

  it('bypasses the cooldown for a severe backlog', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);
    pacer.observe(0, 0, 0);
    pacer.observe(0, 0, 250);
    expect(pacer.currentGear).toBe('normal');

    // Well inside the cooldown, but 32 lines deep: lag the user can see.
    expect(pacer.observe(32, 0, 300)).toBe('flush');
    expect(pacer.currentGear).toBe('catchUp');
  });

  it('bypasses the cooldown for a severe age', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);
    pacer.observe(0, 0, 0);
    pacer.observe(0, 0, 250);
    expect(pacer.currentGear).toBe('normal');

    expect(pacer.observe(3, 300, 300)).toBe('flush');
    expect(pacer.currentGear).toBe('catchUp');
  });

  it('does not thrash when the backlog oscillates around the threshold', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);
    pacer.observe(0, 0, 0);
    pacer.observe(0, 0, 250);
    expect(pacer.currentGear).toBe('normal');

    // Now oscillate across the 3-line threshold for a full cooldown. None of
    // these may enter catch-up: each crossing would be a flush, which is the
    // expensive operation the hysteresis exists to prevent.
    let flushes = 0;
    for (let t = 260; t < 500; t += 10) {
      const lines = t % 20 === 0 ? 4 : 0;
      if (pacer.observe(lines, 0, t) === 'flush') flushes += 1;
    }
    expect(flushes).toBe(0);
    expect(pacer.currentGear).toBe('normal');
  });

  it('reset() returns to normal and clears the cooldown', () => {
    const pacer = new Pacer();
    pacer.observe(3, 0, 0);
    pacer.reset();
    expect(pacer.currentGear).toBe('normal');
    // The cooldown is cleared, so a new spike enters at once.
    expect(pacer.observe(3, 0, 1)).toBe('flush');
  });

  it('honours overridden thresholds', () => {
    const pacer = new Pacer({ enterLines: 10, enterAgeMs: 1000 });
    expect(pacer.observe(5, 0, 0)).toBe('throttled');
    expect(pacer.observe(10, 0, 0)).toBe('flush');
  });
});
