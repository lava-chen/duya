import { describe, expect, it } from 'vitest';
import { computeNextRunAt } from '../../../../electron/automation/schedule';
import type { CronSchedule } from '../../../../electron/automation/types';

describe('computeNextRunAt', () => {
  it('returns future timestamp for a one-shot schedule', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = { kind: 'once', at: new Date(now + 60_000).toISOString() };

    expect(computeNextRunAt(schedule, 0, now)).toBe(now + 60_000);
  });

  it('returns null for a past one-shot', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = { kind: 'once', at: new Date(now - 1).toISOString() };

    expect(computeNextRunAt(schedule, 0, now)).toBeNull();
  });

  it('returns now + period for an every schedule that never ran', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = { kind: 'every', every: '15s' };

    expect(computeNextRunAt(schedule, 0, now)).toBe(now + 15_000);
  });

  it('computes different next-run times for different cron timezones', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const baseExpr = '0 9 * * *';

    const utcSchedule: CronSchedule = { kind: 'cron', expr: baseExpr, tz: 'UTC' };
    const shanghaiSchedule: CronSchedule = { kind: 'cron', expr: baseExpr, tz: 'Asia/Shanghai' };

    const utcNext = computeNextRunAt(utcSchedule, 0, now);
    const shanghaiNext = computeNextRunAt(shanghaiSchedule, 0, now);

    expect(utcNext).not.toBeNull();
    expect(shanghaiNext).not.toBeNull();
    expect(utcNext).not.toBe(shanghaiNext);
  });

  it('does not schedule a run after the repeat end time', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const schedule: CronSchedule = {
      kind: 'every',
      every: '1m',
      endAt: new Date(now + 30_000).toISOString(),
    };

    expect(computeNextRunAt(schedule, 0, now)).toBeNull();
  });
});
