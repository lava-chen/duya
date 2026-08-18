/**
 * Unit tests for low-power config overrides (plan 426 Phase 6.1).
 *
 * Pure-function coverage: lowPower caps `instancesPerMinute` so the
 * effective tick interval floors at 5s and throttles catalogSync to
 * 5min; disabled lowPower is a no-op.
 */
import { describe, it, expect } from 'vitest';
import {
  applyLowPowerOverrides,
  LOW_POWER_CATALOG_SYNC_INTERVAL_MS,
  LOW_POWER_MIN_TICK_MS,
} from './memory-worker';

describe('applyLowPowerOverrides (plan 426 Phase 6.1)', () => {
  it('returns the input unchanged when lowPower is off', () => {
    const cfg = { instancesPerMinute: 60, concurrency: 2 };
    expect(applyLowPowerOverrides(cfg, false)).toBe(cfg);
  });

  it('caps instancesPerMinute so the tick interval floors at 5s', () => {
    const out = applyLowPowerOverrides({ instancesPerMinute: 60, concurrency: 2 }, true);
    expect(out.instancesPerMinute).toBe(Math.floor(60_000 / LOW_POWER_MIN_TICK_MS));
    expect(out.instancesPerMinute).toBe(12); // 60_000 / 12 = 5_000ms tick
  });

  it('throttles catalogSync to 5min when unset (default 60s raised)', () => {
    const out = applyLowPowerOverrides({}, true);
    expect(out.catalogSyncIntervalMs).toBe(LOW_POWER_CATALOG_SYNC_INTERVAL_MS);
    expect(out.catalogSyncIntervalMs).toBe(5 * 60_000);
  });

  it('never speeds up slower caller configs', () => {
    const out = applyLowPowerOverrides(
      { instancesPerMinute: 1, catalogSyncIntervalMs: 600_000 },
      true,
    );
    expect(out.instancesPerMinute).toBe(1);
    expect(out.catalogSyncIntervalMs).toBe(600_000);
  });
});
