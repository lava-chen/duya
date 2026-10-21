// Plan 583 / ISS-10: the stdout write queue must actually be bounded.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import type { sendEvent as SendEvent } from '../src/worker-transport.js';

/**
 * `worker-transport.ts` keeps its queue and its in-flight flag at module
 * scope. That state has to be fresh per case: a case that leaves the pump
 * parked on a `drain` event leaves `isDraining` true, and the next case's
 * `sendEvent` calls then only enqueue — nothing is written, because
 * `sendEvent` skips the pump while the flag is set.
 *
 * The import is therefore dynamic and preceded by `vi.resetModules()`, so
 * each case gets its own module instance. A static import would share one
 * instance across the whole file, which is what made this file order
 * dependent.
 */
let sendEvent: typeof SendEvent;

beforeEach(async () => {
  vi.resetModules();
  ({ sendEvent } = await import('../src/worker-transport.js'));
});

/**
 * Force backpressure so frames pile up in the queue instead of draining.
 *
 * Once the stall is lifted the mock reports the write as ACCEPTED. It must
 * not delegate to the real `process.stdout.write`: the real write's verdict
 * depends on the pipe's buffer state, so on a machine where the pipe is
 * already full it returns false again, the pump parks on `drain` a second
 * time, and that `drain` never arrives — the case then fails on a
 * scheduling accident rather than on the behaviour it is about.
 */
function stallStdout(): { setStalled: (stalled: boolean) => void } {
  let stalled = true;
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    if (stalled) return false;
    void chunk;
    void rest;
    return true;
  }) as never);

  return { setStalled: (value: boolean) => { stalled = value; } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendEvent backpressure queue', () => {
  it('stops growing without bound when stdout refuses writes', () => {
    const { setStalled } = stallStdout();
    const spy = vi.mocked(process.stdout.write);

    // First event: written, write() returns false, so the queue parks on drain.
    sendEvent({ type: 'chat:text', n: 0 });
    expect(spy).toHaveBeenCalledTimes(1);

    // Pile on far more than the 2000-frame cap while stalled.
    for (let i = 1; i <= 2500; i++) {
      sendEvent({ type: 'chat:text', n: i });
    }

    setStalled(false);
    process.stdout.emit('drain');

    const drained = spy.mock.calls.map((call) => String(call[0]));
    // One frame went out before stalling; the rest drained on `drain`.
    const total = drained.length;
    expect(total).toBeGreaterThan(0);
    // Unbounded this would be 2501. Bounded by frames, with the cap at 2000
    // plus the one already written.
    expect(total).toBeLessThanOrEqual(2001);

    // The newest event is the one that must survive the shed.
    expect(drained[drained.length - 1]).toContain('"n":2500');
  });

  it('does not drop frames when stdout keeps up', () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);

    for (let i = 0; i < 50; i++) sendEvent({ type: 'chat:text', n: i });

    expect(written).toHaveLength(50);
    expect(written[49]).toContain('"n":49');
  });
});
