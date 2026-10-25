/**
 * The background-task poller.
 *
 * Its whole job is to read cheaply and go quiet: a read that is not needed is
 * worse than no read (it is a request per second for a session that is idle),
 * and a response that lands after `stop()` must not repaint a disposed app.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundTaskPoller, type BackgroundTaskPollerOptions } from '../background-task-poller.js';
import type { BackgroundTaskListV1 } from '@duya/agent-protocol';

const EMPTY: BackgroundTaskListV1 = { observed: true, tasks: [] };

interface Harness {
  readonly poller: BackgroundTaskPoller;
  readonly list: ReturnType<typeof vi.fn>;
  readonly onChange: ReturnType<typeof vi.fn>;
  readonly onError: ReturnType<typeof vi.fn>;
  state: { active: boolean; session: string | null };
}

function makeHarness(
  overrides: Partial<BackgroundTaskPollerOptions> = {},
): Harness {
  const list = vi.fn(async () => EMPTY);
  const onChange = vi.fn();
  const onError = vi.fn();
  const state = { active: true, session: 'session-1' as string | null };
  const poller = new BackgroundTaskPoller({
    list,
    isActive: () => state.active,
    sessionId: () => state.session,
    onChange,
    onError,
    ...overrides,
  });
  return { poller, list, onChange, onError, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundTaskPoller', () => {
  it('does nothing until started', async () => {
    const harness = makeHarness();
    await expect(harness.poller.poll()).resolves.toBeNull();
    expect(harness.list).not.toHaveBeenCalled();
  });

  it('skips the read when there is nothing worth watching', async () => {
    const harness = makeHarness();
    harness.poller.start();
    harness.state.active = false;
    await expect(harness.poller.poll()).resolves.toBeNull();
    expect(harness.list).not.toHaveBeenCalled();
    harness.poller.stop();
  });

  it('skips the read while the shown session is being switched', async () => {
    const harness = makeHarness();
    harness.poller.start();
    harness.state.session = null;
    await expect(harness.poller.poll()).resolves.toBeNull();
    expect(harness.list).not.toHaveBeenCalled();
    harness.poller.stop();
  });

  it('applies and returns the snapshot', async () => {
    const harness = makeHarness();
    harness.poller.start();
    await expect(harness.poller.poll()).resolves.toBe(EMPTY);
    expect(harness.list).toHaveBeenCalledWith('session-1');
    expect(harness.onChange).toHaveBeenCalledWith(EMPTY);
    expect(harness.onError).not.toHaveBeenCalled();
    harness.poller.stop();
  });

  it('does not start a second read while one is in flight', async () => {
    let release: ((value: BackgroundTaskListV1) => void) | undefined;
    const list = vi.fn(() => new Promise<BackgroundTaskListV1>((resolve) => { release = resolve; }));
    const harness = makeHarness({ list });
    harness.poller.start();

    const first = harness.poller.poll();
    await expect(harness.poller.poll()).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);

    release?.(EMPTY);
    await expect(first).resolves.toBe(EMPTY);
    harness.poller.stop();
  });

  it('reports one failure per burst and resets after a success', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom again'))
      .mockResolvedValueOnce(EMPTY)
      .mockRejectedValueOnce(new Error('boom after recovery'));
    const harness = makeHarness({ list });
    harness.poller.start();

    await expect(harness.poller.poll()).resolves.toBeNull();
    await expect(harness.poller.poll()).resolves.toBeNull();
    // Two failures in the same burst are one message, not one notice a second.
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.onError).toHaveBeenCalledWith(expect.any(Error));

    await expect(harness.poller.poll()).resolves.toBe(EMPTY);
    await expect(harness.poller.poll()).resolves.toBeNull();
    expect(harness.onError).toHaveBeenCalledTimes(2);
    harness.poller.stop();
  });

  it('drops a response that lands after stop', async () => {
    let release: ((value: BackgroundTaskListV1) => void) | undefined;
    const list = vi.fn(() => new Promise<BackgroundTaskListV1>((resolve) => { release = resolve; }));
    const harness = makeHarness({ list });
    harness.poller.start();

    const poll = harness.poller.poll();
    harness.poller.stop();
    release?.(EMPTY);

    await expect(poll).resolves.toBeNull();
    expect(harness.onChange).not.toHaveBeenCalled();
  });

  it('polls on its own interval while started', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ intervalMs: 5 });
    harness.poller.start();
    await vi.advanceTimersByTimeAsync(15);
    expect(harness.list).toHaveBeenCalledTimes(3);
    harness.poller.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.list).toHaveBeenCalledTimes(3);
  });
});
