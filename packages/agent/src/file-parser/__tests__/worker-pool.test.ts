/**
 * worker-pool smoke test
 * Verifies the concurrency cap and queue draining.
 */

import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../worker-pool.js';

describe('WorkerPool', () => {
  it('runs tasks under the cap in parallel', async () => {
    const pool = new WorkerPool({ maxConcurrent: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const results: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      results.push(i);
    });

    await Promise.all(tasks.map((t) => pool.run(t)));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(results.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('respects a concurrency limit of 1 (serial)', async () => {
    const pool = new WorkerPool({ maxConcurrent: 1 });
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
    });
    await Promise.all(tasks.map((t) => pool.run(t)));
    expect(order).toEqual([0, 1, 2]);
  });

  it('rejects queued tasks when disposed', async () => {
    const pool = new WorkerPool({ maxConcurrent: 1 });
    // Fill the active slot
    const blocker = pool.run(() => new Promise<void>((r) => setTimeout(r, 50)));
    // Queue another, but consume the rejection so vitest doesn't see
    // an unhandled promise warning
    const queued = pool.run(() => Promise.resolve('never'));
    queued.catch(() => undefined); // attach a handler BEFORE dispose
    pool.dispose();
    await blocker;
    await expect(queued).rejects.toThrow(/disposed/);
  });

  it('propagates errors without blocking later tasks', async () => {
    const pool = new WorkerPool({ maxConcurrent: 1 });
    const fail = pool.run(() => Promise.reject(new Error('boom')));
    const ok = pool.run(() => Promise.resolve('ok'));
    await expect(fail).rejects.toThrow('boom');
    await expect(ok).resolves.toBe('ok');
  });

  it('exposes activeCount and queueLength', () => {
    const pool = new WorkerPool({ maxConcurrent: 3 });
    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
    expect(pool.concurrencyLimit).toBe(3);
  });
});
