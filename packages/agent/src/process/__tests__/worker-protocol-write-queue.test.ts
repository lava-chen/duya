// Plan 583 / ISS-10: the stdout write queue must actually be bounded.
import { describe, it, expect, vi, afterEach } from 'vitest';

import { sendEvent } from '../worker-protocol.js';

const originalWrite = process.stdout.write.bind(process.stdout);

/** Force backpressure so frames pile up in the queue instead of draining. */
function stallStdout(): { setStalled: (stalled: boolean) => void } {
  let stalled = true;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    if (stalled) return false;
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
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
