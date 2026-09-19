/**
 * Tests for the BashAdmissionController.
 *
 * Mirrors mcode's slot-gate so a single runaway agent loop cannot spawn an
 * unbounded number of detached processes. Covers:
 *   - basic tryAcquire / release semantics
 *   - capacity validation
 *   - acquire(signal) blocking + abort handling
 *   - overflow tokens (used by soft-yield promotion)
 *   - process-wide singleton reset
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BashAdmissionController,
  DEFAULT_BASH_ADMISSION_SLOTS,
  getBashAdmission,
  resetBashAdmission,
} from '../src/session/bash-admission.js';

afterEach(() => {
  resetBashAdmission();
});

describe('BashAdmissionController - construction', () => {
  it('uses the documented default capacity', () => {
    const controller = new BashAdmissionController();
    expect(controller.capacity).toBe(DEFAULT_BASH_ADMISSION_SLOTS);
    expect(DEFAULT_BASH_ADMISSION_SLOTS).toBeGreaterThan(0);
  });

  it('rejects non-positive capacities', () => {
    expect(() => new BashAdmissionController(0)).toThrow();
    expect(() => new BashAdmissionController(-1)).toThrow();
    expect(() => new BashAdmissionController(1.5)).toThrow();
  });

  it('reports zero active count when fresh', () => {
    const controller = new BashAdmissionController(4);
    expect(controller.activeCount).toBe(0);
    expect(controller.queuedCount).toBe(0);
    expect(controller.overflowActiveCount).toBe(0);
  });
});

describe('BashAdmissionController - tryAcquire / release', () => {
  it('grants a slot when capacity is available', () => {
    const controller = new BashAdmissionController(2);
    const t1 = controller.tryAcquire();
    const t2 = controller.tryAcquire();
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(controller.activeCount).toBe(2);
    expect(t1!.slot).not.toBe(t2!.slot);
  });

  it('returns null when the cap is reached', () => {
    const controller = new BashAdmissionController(2);
    controller.tryAcquire();
    controller.tryAcquire();
    expect(controller.tryAcquire()).toBeNull();
    expect(controller.activeCount).toBe(2);
  });

  it('release() returns the slot to the pool and is idempotent', () => {
    const controller = new BashAdmissionController(1);
    const t = controller.tryAcquire()!;
    expect(controller.activeCount).toBe(1);
    t.release();
    expect(controller.activeCount).toBe(0);
    // Second release is a no-op (no throw, no double-count).
    t.release();
    expect(controller.activeCount).toBe(0);
  });

  it('overflow tokens are not counted in activeCount', () => {
    const controller = new BashAdmissionController(1);
    controller.tryAcquire();
    const overflow = controller.acquireOverflow();
    expect(overflow.overflow).toBe(true);
    expect(controller.activeCount).toBe(1);
    expect(controller.overflowActiveCount).toBe(1);
    overflow.release();
    expect(controller.overflowActiveCount).toBe(0);
  });
});

describe('BashAdmissionController - acquire with signal', () => {
  it('resolves immediately when a slot is free', async () => {
    const controller = new BashAdmissionController(2);
    const token = await controller.acquire();
    expect(controller.activeCount).toBe(1);
    token.release();
  });

  it('queues waiters until a slot frees up', async () => {
    const controller = new BashAdmissionController(1);
    const t1 = controller.tryAcquire()!;

    let resolved = false;
    const p = controller.acquire().then((t) => {
      resolved = true;
      return t;
    });

    // Give the microtask queue a chance to drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(controller.queuedCount).toBe(1);

    t1.release();
    const t2 = await p;
    expect(resolved).toBe(true);
    expect(controller.activeCount).toBe(1);
    t2.release();
  });

  it('rejects the queued waiter when its signal aborts', async () => {
    const controller = new BashAdmissionController(1);
    controller.tryAcquire();
    const ac = new AbortController();
    const pending = controller.acquire(ac.signal);
    await Promise.resolve();
    expect(controller.queuedCount).toBe(1);

    ac.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(controller.queuedCount).toBe(0);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new BashAdmissionController(1);
    controller.tryAcquire();
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await expect(controller.acquire(ac.signal)).rejects.toThrow('pre-aborted');
  });
});

describe('BashAdmissionController - singleton', () => {
  it('getBashAdmission returns the same instance', () => {
    const a = getBashAdmission();
    const b = getBashAdmission();
    expect(a).toBe(b);
  });

  it('resetBashAdmission creates a new instance', () => {
    const a = getBashAdmission();
    a.tryAcquire();
    resetBashAdmission();
    const b = getBashAdmission();
    expect(b).not.toBe(a);
    expect(b.activeCount).toBe(0);
  });
});

describe('BashAdmissionController - stress smoke', () => {
  it('handles 100 acquire/release cycles without leaking slots', () => {
    const controller = new BashAdmissionController(8);
    for (let i = 0; i < 100; i += 1) {
      const t = controller.tryAcquire()!;
      t.release();
    }
    expect(controller.activeCount).toBe(0);
    expect(controller.queuedCount).toBe(0);
  });

  it('parallel acquire() across the cap surfaces overflow tokens deterministically', async () => {
    const controller = new BashAdmissionController(4);
    const tokens = Array.from({ length: 10 }, () => controller.acquireOverflow());
    expect(controller.activeCount).toBe(4);
    expect(controller.overflowActiveCount).toBe(6);
    // Release them all and confirm counters go back to zero.
    for (const t of tokens) t.release();
    expect(controller.activeCount).toBe(0);
    expect(controller.overflowActiveCount).toBe(0);
  });
});