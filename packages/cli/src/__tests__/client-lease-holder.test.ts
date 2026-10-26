import { describe, expect, it, vi } from 'vitest';
import type { HostClientLease } from '@duya/host/http-client';
import { holdClientLease, type ClientLeaseTimers } from '../tui/client-lease-holder.js';

interface FakeLease extends HostClientLease {
  lose(reason: string): void;
}

function fakeLease(): FakeLease {
  let lose: (reason: string) => void = () => undefined;
  const lost = new Promise<string>((resolve) => {
    lose = resolve;
  });
  return { close: vi.fn(), lost, lose };
}

/** A scheduler the test advances by hand, so no assertion waits on a timer. */
function manualTimers(): { timers: ClientLeaseTimers; fire(): void; readonly size: number } {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout(callback: () => void): unknown {
        const id = next;
        next += 1;
        pending.set(id, callback);
        return id;
      },
      clearTimeout(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    fire(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    get size(): number {
      return pending.size;
    },
  };
}

describe('holdClientLease', () => {
  it('re-acquires the lease after the Host ends it, and reports the gap', async () => {
    const first = fakeLease();
    const second = fakeLease();
    const open = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const clock = manualTimers();
    const onLost = vi.fn();
    const onReacquired = vi.fn();
    const holder = holdClientLease(
      { openClientLease: open },
      { retryDelaysMs: [10], timers: clock.timers, onLost, onReacquired },
    );

    await vi.waitFor(() => expect(holder.held).toBe(true));
    first.lose('socket reset');

    await vi.waitFor(() => expect(onLost).toHaveBeenCalledWith('socket reset'));
    await vi.waitFor(() => expect(holder.held).toBe(false));
    await vi.waitFor(() => expect(clock.size).toBe(1));
    clock.fire();
    await vi.waitFor(() => expect(holder.held).toBe(true));
    expect(open).toHaveBeenCalledTimes(2);
    expect(onReacquired).toHaveBeenCalledTimes(1);

    holder.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('does not treat a deliberate close as a loss', async () => {
    const lease = fakeLease();
    const open = vi.fn().mockResolvedValueOnce(lease);
    const clock = manualTimers();
    const onLost = vi.fn();
    const holder = holdClientLease(
      { openClientLease: open },
      { retryDelaysMs: [10], timers: clock.timers, onLost },
    );

    await vi.waitFor(() => expect(holder.held).toBe(true));
    holder.close();

    expect(lease.close).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
    expect(clock.size).toBe(0);
  });

  it('cancels a scheduled retry when the terminal closes', async () => {
    const open = vi.fn().mockRejectedValue(new Error('Host is down'));
    const clock = manualTimers();
    const holder = holdClientLease(
      { openClientLease: open },
      { retryDelaysMs: [10], timers: clock.timers },
    );

    await vi.waitFor(() => expect(clock.size).toBe(1));
    holder.close();
    expect(clock.size).toBe(0);

    clock.fire();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('retries a failed acquire instead of giving up', async () => {
    const lease = fakeLease();
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('Host is down'))
      .mockResolvedValueOnce(lease);
    const clock = manualTimers();
    const holder = holdClientLease(
      { openClientLease: open },
      { retryDelaysMs: [10], timers: clock.timers },
    );

    await vi.waitFor(() => expect(clock.size).toBe(1));
    clock.fire();
    await vi.waitFor(() => expect(holder.held).toBe(true));
    expect(open).toHaveBeenCalledTimes(2);
    holder.close();
  });

  it('stops when the Host does not offer leases at all', async () => {
    const clock = manualTimers();
    const open = vi.fn().mockResolvedValue(null);
    const onUnavailable = vi.fn();
    const holder = holdClientLease(
      { openClientLease: open },
      { retryDelaysMs: [10], timers: clock.timers, onUnavailable },
    );

    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(holder.held).toBe(false);
    expect(clock.size).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
