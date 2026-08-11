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

  it('cron: computes the next occurrence', () => {
    const next = computeNextRunAt({ kind: 'cron', expr: '0 9 * * *' }, 0, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
  });

  it('respects endAt', () => {
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-11T01:00:00Z' }, 0, now)).toBe(now + 3_600_000);
    expect(computeNextRunAt({ kind: 'every', every: '1h', endAt: '2026-08-10T00:00:00Z' }, 0, now)).toBeNull();
  });
});
