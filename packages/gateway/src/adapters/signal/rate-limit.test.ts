import { describe, expect, it } from 'vitest';

import { TokenBucket, tokenCostForAttachments } from './rate-limit.js';

function bucketWithClock(capacity = 2, refillMs = 1000) {
  let now = 0;
  const sleeps: number[] = [];
  const bucket = new TokenBucket({
    capacity,
    refillMs,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { bucket, sleeps, advance: (ms: number) => { now += ms; } };
}

describe('TokenBucket', () => {
  it('starts full and spends tokens without sleeping', async () => {
    const { bucket, sleeps } = bucketWithClock(2, 1000);
    expect(bucket.available()).toBe(2);

    await bucket.acquire();
    await bucket.acquire();

    expect(bucket.available()).toBe(0);
    expect(sleeps).toHaveLength(0);
  });

  it('waits for a refill when the bucket is empty', async () => {
    const { bucket, sleeps } = bucketWithClock(1, 1000);
    await bucket.acquire();
    await bucket.acquire();

    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it('caps refill at the capacity', () => {
    const { bucket, advance } = bucketWithClock(2, 1000);
    void bucket.acquire();
    advance(60_000);
    expect(bucket.available()).toBe(2);
  });

  it('serializes concurrent acquisitions so they cannot share a token', async () => {
    const { bucket } = bucketWithClock(1, 1000);
    let granted = 0;
    await Promise.all([
      bucket.acquire().then(() => { granted += 1; }),
      bucket.acquire().then(() => { granted += 1; }),
      bucket.acquire().then(() => { granted += 1; }),
    ]);
    expect(granted).toBe(3);
  });

  it('adopts the server retry-after on feedback', () => {
    const { bucket } = bucketWithClock(10, 1000);
    bucket.feedback(4, 1);
    expect(bucket.available()).toBe(0);
  });

  it('never blocks when asked for more than the capacity', async () => {
    const { bucket, sleeps } = bucketWithClock(2, 1000);
    await bucket.acquire(99);
    expect(sleeps).toHaveLength(0);
    expect(bucket.available()).toBe(0);
  });
});

describe('tokenCostForAttachments', () => {
  it('charges one token per 32 attachments', () => {
    expect(tokenCostForAttachments(0)).toBe(1);
    expect(tokenCostForAttachments(31)).toBe(1);
    expect(tokenCostForAttachments(32)).toBe(2);
    expect(tokenCostForAttachments(64)).toBe(3);
  });
});
