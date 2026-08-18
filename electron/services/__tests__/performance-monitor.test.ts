/**
 * Unit tests for PerformanceMonitor low-power gating (plan 426 Phase 6.2).
 *
 * lowPower must skip memory sampling, leak detection, and the 60s
 * metrics export; only base counters keep running. The check runs per
 * tick so toggling `performance.lowPower` applies live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lowPowerState = vi.hoisted(() => ({ enabled: false }));

vi.mock('electron', () => ({ app: {} }));
vi.mock('../low-power', () => ({
  isLowPowerEnabled: () => lowPowerState.enabled,
}));

import { PerformanceMonitor } from '../performance-monitor';

describe('PerformanceMonitor low-power gating (plan 426 Phase 6.2)', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    lowPowerState.enabled = false;
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    monitor.shutdown();
    vi.useRealTimers();
  });

  it('exports metrics every 60s when lowPower is off', () => {
    const onExport = vi.fn();
    monitor.onExport(onExport);

    vi.advanceTimersByTime(60_000);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('skips sampling and export while lowPower is on', () => {
    lowPowerState.enabled = true;
    const onExport = vi.fn();
    const onLeak = vi.fn();
    monitor.onExport(onExport);
    monitor.on('memory:leak_alert', onLeak);
    const snapshotSpy = vi.spyOn(monitor, 'recordMemorySnapshot');

    vi.advanceTimersByTime(5 * 60_000);
    expect(onExport).not.toHaveBeenCalled();
    expect(onLeak).not.toHaveBeenCalled();
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it('resumes export when lowPower turns back off', () => {
    lowPowerState.enabled = true;
    const onExport = vi.fn();
    monitor.onExport(onExport);

    vi.advanceTimersByTime(3 * 60_000);
    expect(onExport).not.toHaveBeenCalled();

    lowPowerState.enabled = false;
    vi.advanceTimersByTime(60_000);
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
