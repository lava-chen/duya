import { describe, it, expect } from 'vitest';
import { calculateBackoffDelay, sleep } from '../src/utils/backoff.js';

describe('calculateBackoffDelay', () => {
  it('grows exponentially and respects maxDelay', () => {
    const d1 = calculateBackoffDelay(1, { baseDelayMs: 100, maxDelayMs: 32000, multiplier: 2, jitterFactor: 0 });
    const d2 = calculateBackoffDelay(3, { baseDelayMs: 100, maxDelayMs: 32000, multiplier: 2, jitterFactor: 0 });
    expect(d1).toBe(100);
    expect(d2).toBe(400);
    const capped = calculateBackoffDelay(10, { baseDelayMs: 100, maxDelayMs: 150, multiplier: 2, jitterFactor: 0 });
    expect(capped).toBe(150);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const t0 = Date.now();
    await sleep(10);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(8);
  });
});