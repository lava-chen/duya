// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePolling } from '../usePolling';

const mockLowPower = vi.hoisted(() => ({ value: false }));

vi.mock('@/stores/low-power-store', () => ({
  useLowPower: () => mockLowPower.value,
}));

/** Set document.hidden and notify listeners, mimicking tab hide/show. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLowPower.value = false;
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.useRealTimers();
  });

  it('runs the first tick immediately on mount', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs fn on each interval expiry', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2); // 1 immediate + 1 interval tick

    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(5); // +3 more interval ticks
  });

  it('skips ticks while activeWhen returns false and resumes once it returns true', () => {
    const gate = { active: false };
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { activeWhen: () => gate.active }));

    // Both the immediate tick and the first interval tick are gated out.
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();

    gate.active = true;
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    gate.active = false;
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pauses while document is hidden, then fires an immediate tick and restarts the interval on regain', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);

    act(() => {
      setHidden(true);
    });
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1); // paused while hidden

    act(() => {
      setHidden(false);
    });
    expect(fn).toHaveBeenCalledTimes(2); // catch-up tick on regain

    // The interval restarted from the regain moment, not from mount.
    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops the interval when mounted while the document is already hidden', () => {
    const fn = vi.fn();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });

    renderHook(() => usePolling(fn, 1000));

    // Suspended at mount: not even the immediate tick runs.
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled(); // no interval ticks while hidden
  });

  it('multiplies the interval by the default low-power multiplier of 4', () => {
    mockLowPower.value = true;
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    expect(fn).toHaveBeenCalledTimes(1); // immediate tick still runs

    vi.advanceTimersByTime(3999);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // effective interval is 4000ms
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors a custom lowPowerMultiplier', () => {
    mockLowPower.value = true;
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { lowPowerMultiplier: 2 }));

    vi.advanceTimersByTime(1999);
    expect(fn).toHaveBeenCalledTimes(1); // only the immediate tick so far
    vi.advanceTimersByTime(1); // effective interval is 2000ms
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('skips the immediate tick when noImmediate is true', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { noImmediate: true }));

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears the interval on unmount', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(10000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
