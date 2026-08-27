/**
 * electron/automation/schedule.test.ts — pure schedule helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  assertValidSchedule,
  computeNextRunAt,
  formatEveryDuration,
  parseEveryDuration,
} from './schedule';
import type { CronSchedule } from './types';

const now = Date.parse('2026-08-11T00:00:00Z');

describe('parseEveryDuration', () => {
  it('parses s/m/h/d/w', () => {
    expect(parseEveryDuration('5s')).toBe(5_000);
    expect(parseEveryDuration('30m')).toBe(30 * 60_000);
    expect(parseEveryDuration('1h')).toBe(3_600_000);
    expect(parseEveryDuration('1d')).toBe(86_400_000);
    expect(parseEveryDuration('2w')).toBe(2 * 604_800_000);
  });

  it('throws on invalid input', () => {
    expect(() => parseEveryDuration('abc')).toThrow();
    expect(() => parseEveryDuration('')).toThrow();
    expect(() => parseEveryDuration('5')).toThrow();
  });
});

describe('formatEveryDuration', () => {
  it('formats back to a compact string', () => {
    expect(formatEveryDuration(86_400_000)).toBe('1d');
    expect(formatEveryDuration(3_600_000)).toBe('1h');
    expect(formatEveryDuration(60_000)).toBe('1m');
    expect(formatEveryDuration(1_000)).toBe('1s');
  });
});

describe('assertValidSchedule', () => {
  it('accepts once / every / cron', () => {
    expect(() => assertValidSchedule({ kind: 'once', at: '2026-12-31T00:00:00Z' })).not.toThrow();
    expect(() => assertValidSchedule({ kind: 'every', every: '1d' })).not.toThrow();
    expect(() => assertValidSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).not.toThrow();
  });

  it('rejects malformed schedules with actionable messages', () => {
    expect(() => assertValidSchedule({ kind: 'once', at: '' })).toThrow(/schedule\.at is required/);
    expect(() => assertValidSchedule({ kind: 'every', every: 'bogus' })).toThrow(/invalid every duration/);
    expect(() => assertValidSchedule({ kind: 'cron', expr: 'not a cron' })).toThrow(/invalid cron expression/);
    expect(() => assertValidSchedule({ kind: 'yearly' } as unknown as CronSchedule)).toThrow(/unsupported schedule\.kind/);
    expect(() => assertValidSchedule({ kind: 'every', every: '1h', endAt: 'not-a-date' })).toThrow(/endAt must be an ISO/);
  });
});

describe('computeNextRunAt', () => {
  it('once: returns at when future, null when past', () => {
    expect(computeNextRunAt({ kind: 'once', at: '2026-12-31T00:00:00Z' }, 0, now)).toBe(Date.parse('2026-12-31T00:00:00Z'));
    expect(computeNextRunAt({ kind: 'once', at: '2020-01-01T00:00:00Z' }, 0, now)).toBeNull();
  });

  it('every: anchors cadence on lastRunAt when present', () => {
    const last = now - 86_400_000;
    expect(computeNextRunAt({ kind: 'every', every: '1d' }, last, now)).toBe(last + 86_400_000);
    // never ran → phase starts at now
    expect(computeNextRunAt({ kind: 'every', every: '1h' }, 0, now)).toBe(now + 3_600_000);
  });

  it('cron: returns the first occurrence strictly after the anchor', () => {
    // Pin TZ so the assertion is not flaky on hosts whose local timezone is
    // not UTC — croner interprets a tz-less cron in the host's local zone.
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' };
    // Anchor on epoch (lastRunAt = 0, never fired) → first 9am UTC after the epoch.
    expect(computeNextRunAt(schedule, 0, now)).toBe(Date.UTC(1970, 0, 1, 9, 0, 0));
    // Anchor on yesterday 09:30 UTC (last fire drifted past the schedule) →
    // next runtime is today's 09:00 UTC.
    expect(
      computeNextRunAt(schedule, Date.UTC(2026, 7, 10, 9, 30, 0), now),
    ).toBe(Date.UTC(2026, 7, 11, 9, 0, 0));
  });

  it('cron: returns past occurrences as-is so the scheduler can catch up', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' };
    // Tick lands 30s after yesterday's scheduled fire. nextRunAt must be the
    // missed occurrence (yesterday 09:00 UTC) so the scheduler tick filter
    // `nextRunAt <= now` matches and fires the job. Regression guard for the
    // bug where nextRun(now) always returned a future time and the cron
    // could never fire via the polling tick.
    const tickAt = Date.UTC(2026, 7, 11, 9, 0, 30);
    const next = computeNextRunAt(schedule, Date.UTC(2026, 7, 10, 9, 0, 0), tickAt);
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(tickAt);
    expect(next!).toBe(Date.UTC(2026, 7, 11, 9, 0, 0));
  });

  it('cron: respects endAt by returning null when the next occurrence is past it', () => {
    const schedule: CronSchedule = {
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'UTC',
      endAt: '2026-08-10T08:00:00Z',
    };
    // Last fire was well before endAt; the next 9am would be after endAt.
    expect(computeNextRunAt(schedule, Date.UTC(2026, 7, 9, 9, 0, 0), now)).toBeNull();
  });

  it('respects endAt', () => {
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-11T01:00:00Z' }, 0, now)).toBe(now + 3_600_000);
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-10T00:00:00Z' }, 0, now)).toBeNull();
  });
});
