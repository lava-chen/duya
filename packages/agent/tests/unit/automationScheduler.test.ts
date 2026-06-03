import { describe, expect, it } from 'vitest';
import { computeNextRunAtMs } from '../../../../electron/automation/Scheduler';
import type { CronSchedule } from '../../../../electron/automation/types';

describe('computeNextRunAtMs', () => {
  it('returns future timestamp for `at` schedule', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = {
      kind: 'at',
      at: new Date(now + 60_000).toISOString(),
    };

    expect(computeNextRunAtMs(schedule, now)).toBe(now + 60_000);
  });

  it('returns null for past `at` schedule', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = {
      kind: 'at',
      at: new Date(now - 1).toISOString(),
    };

    expect(computeNextRunAtMs(schedule, now)).toBeNull();
  });

  it('returns now + everyMs for `every` schedule', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = { kind: 'every', everyMs: 15_000 };

    expect(computeNextRunAtMs(schedule, now)).toBe(now + 15_000);
  });

  it('computes different next-run times for different cron timezones', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const baseExpr = '0 9 * * *';

    const utcSchedule: CronSchedule = {
      kind: 'cron',
      cronExpr: baseExpr,
      cronTz: 'UTC',
    };
    const shanghaiSchedule: CronSchedule = {
      kind: 'cron',
      cronExpr: baseExpr,
      cronTz: 'Asia/Shanghai',
    };

    const utcNext = computeNextRunAtMs(utcSchedule, now);
    const shanghaiNext = computeNextRunAtMs(shanghaiSchedule, now);

    expect(utcNext).not.toBeNull();
    expect(shanghaiNext).not.toBeNull();
    expect(utcNext).not.toBe(shanghaiNext);
  });
});
