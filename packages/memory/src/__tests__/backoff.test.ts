import { describe, it, expect } from 'vitest';
import {
  computeRetryBackoffMs,
  shouldRetire,
  BACKOFF_SEQUENCE_MINUTES,
  MAX_RETRY_ATTEMPTS,
} from '../lease';

/**
 * Backoff matrix (Plan 302 Phase C). Pure-function coverage of the
 * retry schedule; the integration side (fail() writing next_retry_at)
 * is covered by lease.test.ts scenarios 6-7.
 *
 * | attempt | expected backoff |
 * |---------|------------------|
 * | 1       | 5 minutes        |
 * | 2       | 15 minutes       |
 * | 3       | 60 minutes       |
 * | 4-6     | 360 minutes      |
 * | 7-9     | 1440 minutes     |
 * | >=10    | null (retire)    |
 */
describe('computeRetryBackoffMs', () => {
  const MIN = 60 * 1000;

  it('attempt 1 → 5 minutes', () => {
    expect(computeRetryBackoffMs(1)).toBe(5 * MIN);
  });

  it('attempt 2 → 15 minutes', () => {
    expect(computeRetryBackoffMs(2)).toBe(15 * MIN);
  });

  it('attempt 3 → 60 minutes', () => {
    expect(computeRetryBackoffMs(3)).toBe(60 * MIN);
  });

  it('attempts 4-6 → 360 minutes', () => {
    expect(computeRetryBackoffMs(4)).toBe(360 * MIN);
    expect(computeRetryBackoffMs(5)).toBe(360 * MIN);
    expect(computeRetryBackoffMs(6)).toBe(360 * MIN);
  });

  it('attempts 7-9 → 1440 minutes', () => {
    expect(computeRetryBackoffMs(7)).toBe(1440 * MIN);
    expect(computeRetryBackoffMs(8)).toBe(1440 * MIN);
    expect(computeRetryBackoffMs(9)).toBe(1440 * MIN);
  });

  it('attempt >= 10 → null (permanent retire)', () => {
    expect(computeRetryBackoffMs(10)).toBeNull();
    expect(computeRetryBackoffMs(25)).toBeNull();
  });

  it('sequence table covers exactly attempts 1..9', () => {
    expect(BACKOFF_SEQUENCE_MINUTES).toHaveLength(MAX_RETRY_ATTEMPTS - 1);
    expect(BACKOFF_SEQUENCE_MINUTES).toEqual([5, 15, 60, 360, 360, 360, 1440, 1440, 1440]);
  });

  it('out-of-range low attempts clamp to the first entry', () => {
    expect(computeRetryBackoffMs(0)).toBe(5 * MIN);
  });
});

describe('shouldRetire', () => {
  it('attempts below MAX do not retire', () => {
    expect(shouldRetire(1)).toBe(false);
    expect(shouldRetire(9)).toBe(false);
  });

  it('attempts at or above MAX retire', () => {
    expect(shouldRetire(10)).toBe(true);
    expect(shouldRetire(11)).toBe(true);
  });
});
