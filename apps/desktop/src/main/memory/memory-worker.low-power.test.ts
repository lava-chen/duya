/**
 * Unit tests for low-power config overrides (plan 426 Phase 6.1).
 *
 * Pure-function coverage: lowPower floors `extractEveryMs` so the
 * effective tick interval is at least 5s and throttles catalogSync to
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
    const cfg = { extractEveryMs: 300_000, concurrency: 2 };
    expect(applyLowPowerOverrides(cfg, false)).toBe(cfg);
  });

  it('floors extractEveryMs at 5s (never faster), keeps slower configs', () => {
    // Default 5min is already slower than the 5s floor — untouched.
    const out = applyLowPowerOverrides({ extractEveryMs: 300_000, concurrency: 2 }, true);
    expect(out.extractEveryMs).toBe(300_000);
    // An explicit 2s interval is raised to the 5s low-power floor.
    const fast = applyLowPowerOverrides({ extractEveryMs: 2_000, concurrency: 2 }, true);
    expect(fast.extractEveryMs).toBe(LOW_POWER_MIN_TICK_MS);
    expect(fast.extractEveryMs).toBe(5_000);
  });

  it('throttles catalogSync to 5min when unset (default 60s raised)', () => {
    const out = applyLowPowerOverrides({}, true);
    expect(out.catalogSyncIntervalMs).toBe(LOW_POWER_CATALOG_SYNC_INTERVAL_MS);
    expect(out.catalogSyncIntervalMs).toBe(5 * 60_000);
  });

  it('never speeds up slower caller configs', () => {
    const out = applyLowPowerOverrides(
      { extractEveryMs: 60_000, catalogSyncIntervalMs: 600_000 },
      true,
    );
    expect(out.extractEveryMs).toBe(60_000);
    expect(out.catalogSyncIntervalMs).toBe(600_000);
  });
});
