/**
 * apps/desktop/src/main/automation/schedule.test.ts — pure schedule helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  assertValidSchedule,
  computeNextRunAt,
  formatEveryDuration,
  parseEveryDuration,
  planDueRoutineFires,
  routineFireKey,
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

  it('cron: the schedule timezone changes the result, not the expression', () => {
    // Relocated from packages/agent/tests/unit/automationScheduler.test.ts,
    // which reached into this module by relative path from the agent package
    // (plan 587 M5.2, the last `pkg:agent -> electron-main` value edge). The
    // other four cases it held were already pinned here; this is the one that
    // was not, so it moved with the file rather than being dropped.
    const baseExpr = '0 9 * * *';
    const utcNext = computeNextRunAt({ kind: 'cron', expr: baseExpr, tz: 'UTC' }, 0, now);
    const shanghaiNext = computeNextRunAt({ kind: 'cron', expr: baseExpr, tz: 'Asia/Shanghai' }, 0, now);

    expect(utcNext).not.toBeNull();
    expect(shanghaiNext).not.toBeNull();
    expect(utcNext).not.toBe(shanghaiNext);
  });

  it('respects endAt', () => {
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-11T01:00:00Z' }, 0, now)).toBe(now + 3_600_000);
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-10T00:00:00Z' }, 0, now)).toBeNull();
  });
});

const DAILY_9AM_UTC: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' };

describe('routineFireKey (S6)', () => {
  const base = {
    routineId: 'job-a',
    scheduleFingerprint: 'cron:0 9 * * *|UTC',
    scheduledForMs: Date.UTC(2026, 7, 11, 9, 0, 0),
  };

  it('is identical for the same routine, schedule and scheduled instant', () => {
    const key = routineFireKey(base);
    expect(routineFireKey({ ...base })).toBe(key);
    expect(key).toMatch(/^r1:job-a:\d+:[0-9a-f]{8}$/);
    expect(key).toContain(`:${base.scheduledForMs}:`);
  });

  it('changes when the instant, the cadence or the routine changes', () => {
    const key = routineFireKey(base);
    expect(routineFireKey({ ...base, scheduledForMs: base.scheduledForMs + 86_400_000 })).not.toBe(key);
    expect(routineFireKey({ ...base, scheduleFingerprint: 'cron:0 10 * * *|UTC' })).not.toBe(key);
    expect(routineFireKey({ ...base, routineId: 'job-b' })).not.toBe(key);
  });

  it('rejects inputs that could collide across routines', () => {
    expect(() => routineFireKey({ ...base, routineId: '  ' })).toThrow(/routineId/);
    expect(() => routineFireKey({ ...base, scheduledForMs: 0 })).toThrow(/scheduledForMs/);
    expect(() => routineFireKey({ ...base, scheduledForMs: -1 })).toThrow(/scheduledForMs/);
    expect(() => routineFireKey({ ...base, scheduledForMs: 1.5 })).toThrow(/scheduledForMs/);
  });
});

describe('planDueRoutineFires (S6)', () => {
  it('latest: a three-day outage compensates with the newest instant only', () => {
    const plan = planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 8, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 30, 0),
      policy: 'latest',
    });
    expect(plan).toEqual([Date.UTC(2026, 7, 11, 9, 0, 0)]);
  });

  it('bounded: fires the newest N instants, ascending', () => {
    const plan = planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 1, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'bounded',
      maxCatchUp: 3,
    });
    expect(plan).toEqual([
      Date.UTC(2026, 7, 9, 9, 0, 0),
      Date.UTC(2026, 7, 10, 9, 0, 0),
      Date.UTC(2026, 7, 11, 9, 0, 0),
    ]);
  });

  it('bounded: never exceeds the hard cap, and clamps invalid sizes', () => {
    const input = {
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 1, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'bounded' as const,
    };
    expect(planDueRoutineFires({ ...input, maxCatchUp: 99 })).toHaveLength(5);
    expect(planDueRoutineFires({ ...input, maxCatchUp: 99 })[0]).toBe(Date.UTC(2026, 7, 7, 9, 0, 0));
    expect(planDueRoutineFires({ ...input, maxCatchUp: 0 })).toEqual([Date.UTC(2026, 7, 11, 9, 0, 0)]);
  });

  it('bounded: stops at the anchor instead of inventing earlier instants', () => {
    const plan = planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 10, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'bounded',
      maxCatchUp: 5,
    });
    expect(plan).toEqual([Date.UTC(2026, 7, 11, 9, 0, 0)]);
  });

  it('skip: fires inside the grace window and drops a longer gap', () => {
    expect(planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 10, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 9, 0, 30),
      policy: 'skip',
    })).toEqual([Date.UTC(2026, 7, 11, 9, 0, 0)]);
    expect(planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 10, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'skip',
    })).toEqual([]);
    expect(planDueRoutineFires({
      schedule: DAILY_9AM_UTC,
      afterMs: Date.UTC(2026, 7, 10, 9, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'skip',
      graceMs: 4 * 3_600_000,
    })).toEqual([Date.UTC(2026, 7, 11, 9, 0, 0)]);
  });

  it('every: newest instant only, or the newest N', () => {
    const schedule: CronSchedule = { kind: 'every', every: '10m' };
    const anchor = Date.UTC(2026, 7, 11, 10, 0, 0);
    const tickAt = Date.UTC(2026, 7, 11, 10, 32, 0);
    expect(planDueRoutineFires({ schedule, afterMs: anchor, nowMs: tickAt, policy: 'latest' }))
      .toEqual([Date.UTC(2026, 7, 11, 10, 30, 0)]);
    expect(planDueRoutineFires({ schedule, afterMs: anchor, nowMs: tickAt, policy: 'bounded', maxCatchUp: 3 }))
      .toEqual([
        Date.UTC(2026, 7, 11, 10, 10, 0),
        Date.UTC(2026, 7, 11, 10, 20, 0),
        Date.UTC(2026, 7, 11, 10, 30, 0),
      ]);
    // Nothing due yet: the anchor plus one interval is still in the future.
    expect(planDueRoutineFires({ schedule, afterMs: anchor, nowMs: anchor + 60_000, policy: 'bounded', maxCatchUp: 3 }))
      .toEqual([]);
  });

  it('respects endAt for every schedules', () => {
    expect(planDueRoutineFires({
      schedule: { kind: 'every', every: '1h', endAt: '2026-08-11T01:30:00Z' },
      afterMs: Date.UTC(2026, 7, 11, 0, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 3, 0, 0),
      policy: 'latest',
    })).toEqual([]);
  });

  it('once: a missed one-shot fires late exactly once, whatever the policy', () => {
    const schedule: CronSchedule = { kind: 'once', at: '2026-08-11T09:00:00Z' };
    const at = Date.parse('2026-08-11T09:00:00Z');
    // Missed while the machine was off for three days.
    expect(planDueRoutineFires({
      schedule,
      afterMs: Date.UTC(2026, 7, 10, 0, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'skip',
    })).toEqual([at]);
    expect(planDueRoutineFires({
      schedule,
      afterMs: Date.UTC(2026, 7, 10, 0, 0, 0),
      nowMs: Date.UTC(2026, 7, 11, 12, 0, 0),
      policy: 'bounded',
      maxCatchUp: 5,
    })).toEqual([at]);
    // Already claimed (lastRunAt = the instant) or not due yet.
    expect(planDueRoutineFires({ schedule, afterMs: at, nowMs: Date.UTC(2026, 7, 11, 12, 0, 0) })).toEqual([]);
    expect(planDueRoutineFires({ schedule, afterMs: at - 86_400_000, nowMs: at - 1 })).toEqual([]);
  });

  it('DST spring forward: 23h between daily 9am fires, newest only', () => {
    const ny9am: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' };
    // 2026-03-07 09:00 EST = 14:00Z; 2026-03-08 09:00 EDT = 13:00Z.
    const lastFire = Date.parse('2026-03-07T14:00:00Z');
    const plan = planDueRoutineFires({
      schedule: ny9am,
      afterMs: lastFire,
      nowMs: Date.parse('2026-03-08T15:00:00Z'),
      policy: 'latest',
    });
    expect(plan).toEqual([Date.parse('2026-03-08T13:00:00Z')]);
    expect(plan[0] - lastFire).toBe(23 * 3_600_000);
  });

  it('DST fall back: 25h between daily 9am fires, no duplicate instant', () => {
    const ny9am: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' };
    // 2026-10-31 09:00 EDT = 13:00Z; 2026-11-01 09:00 EST = 14:00Z.
    const lastFire = Date.parse('2026-10-31T13:00:00Z');
    const plan = planDueRoutineFires({
      schedule: ny9am,
      afterMs: lastFire,
      nowMs: Date.parse('2026-11-01T15:00:00Z'),
      policy: 'bounded',
      maxCatchUp: 5,
    });
    expect(plan).toEqual([Date.parse('2026-11-01T14:00:00Z')]);
    expect(plan[0] - lastFire).toBe(25 * 3_600_000);
  });

  it('DST week: bounded catch-up covers the skipped hour exactly once', () => {
    const ny9am: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' };
    const plan = planDueRoutineFires({
      schedule: ny9am,
      afterMs: Date.parse('2026-03-06T14:00:00Z'),
      nowMs: Date.parse('2026-03-09T15:00:00Z'),
      policy: 'bounded',
      maxCatchUp: 5,
    });
    expect(plan).toEqual([
      Date.parse('2026-03-07T14:00:00Z'),
      Date.parse('2026-03-08T13:00:00Z'),
      Date.parse('2026-03-09T13:00:00Z'),
    ]);
    expect(new Set(plan).size).toBe(plan.length);
  });
});

it('skip resumes at the next on-time occurrence after an offline gap', () => {
  expect(planDueRoutineFires({ schedule: DAILY_9AM_UTC,
    afterMs: Date.UTC(2026, 7, 8, 9), nowMs: Date.UTC(2026, 7, 11, 9, 0, 30), policy: 'skip',
  })).toEqual([Date.UTC(2026, 7, 11, 9)]);
});

it('rejects zero and overflowing intervals before they can poison catch-up', () => {
  for (const every of ['0s', '999999999999999999999w']) {
    expect(() => assertValidSchedule({ kind: 'every', every })).toThrow(/positive safe integer/);
  }
});

it('does not fire a one-shot beyond its endAt', () => {
  expect(planDueRoutineFires({ schedule: { kind: 'once', at: '2026-08-11T09:00:00Z',
    endAt: '2026-08-11T08:00:00Z' }, afterMs: 0, nowMs: Date.UTC(2026, 7, 11, 12),
  })).toEqual([]);
});
