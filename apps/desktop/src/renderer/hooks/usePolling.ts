'use client';

import { useEffect, useRef } from 'react';
import { useLowPower } from '@/stores/low-power-store';

/**
 * Centralized polling hook (plan 426 Phase 4).
 *
 * Replaces ad-hoc `setInterval` call sites with one implementation that:
 * - pauses while `document.hidden` (resumes with an immediate tick on
 *   visibility regain),
 * - skips ticks when `opts.activeWhen` returns false (e.g. dialog closed,
 *   stream finished),
 * - multiplies the interval by `lowPowerMultiplier` (default 4) when
 *   low-power mode is active,
 * - runs the first tick immediately on mount.
 *
 * `fn` and `activeWhen` are captured via refs — the latest closure runs on
 * each tick without restarting the interval.
 */

export const LOW_POWER_POLLING_MULTIPLIER = 4;

export interface UsePollingOptions {
  /** Extra gate: polling only runs while this returns true. */
  activeWhen?: () => boolean;
  /** Pause while the document is hidden (default true). */
  pauseWhenHidden?: boolean;
  /** Interval multiplier under low-power mode (default 4). */
  lowPowerMultiplier?: number;
  /** Skip the immediate first tick on mount (default false). */
  noImmediate?: boolean;
}

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: UsePollingOptions = {},
): void {
  const lowPower = useLowPower();
  const {
    activeWhen,
    pauseWhenHidden = true,
    lowPowerMultiplier = LOW_POWER_POLLING_MULTIPLIER,
    noImmediate = false,
  } = opts;

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const activeWhenRef = useRef(activeWhen);
  activeWhenRef.current = activeWhen;

  const effectiveInterval = lowPower ? intervalMs * lowPowerMultiplier : intervalMs;

  useEffect(() => {
    if (effectiveInterval <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = (): void => {
      if (activeWhenRef.current && !activeWhenRef.current()) return;
      void fnRef.current();
    };

    const start = (withImmediate: boolean): void => {
      stop();
      if (withImmediate) tick();
      timer = setInterval(tick, effectiveInterval);
    };

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = (): void => {
      if (!pauseWhenHidden) return;
      if (document.hidden) {
        stop();
      } else {
        // Regained visibility — refresh immediately instead of waiting
        // for the next (possibly ×4-slowed) tick.
        start(true);
      }
    };

    const suspendedAtMount =
      pauseWhenHidden && typeof document !== 'undefined' && document.hidden;
    // Do not run any tick (not even the immediate one) if the page is
    // already hidden — resume via the visibilitychange handler instead.
    if (!suspendedAtMount) start(!noImmediate);
    if (pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      stop();
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [effectiveInterval, pauseWhenHidden, noImmediate]);
}
