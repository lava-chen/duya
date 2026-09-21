/**
 * recorder/focus-tracker.ts — unit tests.
 *
 * The PowerShell query is mocked (vi.mock of computer-use-backend keeps
 * the electron import out of the test run); covers change detection,
 * failed-query resilience, and stop().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryResult: { value: null as null | { hwnd: number; pid: number; processName: string; title: string } },
  queryCalls: { value: 0 },
}));

vi.mock('../computer-use-backend.js', () => ({
  getForegroundWindowInfo: async () => {
    mocks.queryCalls.value += 1;
    return mocks.queryResult.value;
  },
}));

vi.mock('../../logging/logger', () => {
  const noop = () => undefined;
  return {
    getLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop, fatal: noop }),
    LogComponent: { ComputerUse: 'ComputerUse' },
  };
});

import { RecorderFocusTracker } from '../recorder/focus-tracker';

const WIN1 = { hwnd: 111, pid: 42, processName: 'notepad', title: 'notes.txt' };
const WIN1_RETITLE = { hwnd: 111, pid: 42, processName: 'notepad', title: 'notes2.txt' };
const WIN2 = { hwnd: 222, pid: 7, processName: 'chrome', title: 'New Tab' };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.queryResult.value = null;
  mocks.queryCalls.value = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecorderFocusTracker', () => {
  it('reports a change on the first snapshot and on hwnd/title moves', async () => {
    const changes: Array<[unknown, unknown]> = [];
    const tracker = new RecorderFocusTracker({ onChange: (prev, next) => changes.push([prev, next]) });
    tracker.start();

    // The immediate start() query runs before the result is staged; the
    // first staged snapshot is picked up by the next 500ms tick.
    mocks.queryResult.value = WIN1;
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(1);

    // Same window again → no change.
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(1);

    // Title change → change event (same hwnd+pid).
    mocks.queryResult.value = WIN1_RETITLE;
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(2);

    // Different window → change event with prev snapshot.
    mocks.queryResult.value = WIN2;
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(3);
    const [prev, next] = changes[2]! as [unknown, unknown];
    expect(prev).toMatchObject({ hwnd: 111 });
    expect(next).toMatchObject({ hwnd: 222 });

    await tracker.stop();
  });

  it('a failed query keeps the previous snapshot (no change spam)', async () => {
    const changes: unknown[] = [];
    const tracker = new RecorderFocusTracker({ onChange: () => changes.push(1) });
    tracker.start();

    mocks.queryResult.value = WIN1;
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(1);

    mocks.queryResult.value = null; // PowerShell hiccup
    await vi.advanceTimersByTimeAsync(1500);
    expect(changes).toHaveLength(1);

    // And the next good query still compares against WIN1.
    mocks.queryResult.value = WIN1;
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(1);

    await tracker.stop();
  });

  it('stop() halts polling', async () => {
    const changes: unknown[] = [];
    const tracker = new RecorderFocusTracker({ onChange: () => changes.push(1) });
    tracker.start();
    await tracker.stop();

    mocks.queryResult.value = WIN1;
    const callsBefore = mocks.queryCalls.value;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.queryCalls.value).toBe(callsBefore);
    expect(changes).toHaveLength(0);
  });
});
