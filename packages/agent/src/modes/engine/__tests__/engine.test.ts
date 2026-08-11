/**
 * ModeTrackerEngine — registration container tests (plan 413a).
 *
 * Covers:
 *   - register + has/get/list
 *   - duplicate-id registration throws
 *   - snapshots() collects every tracker's persisted snapshot
 *   - restore() hits a registered tracker / misses on unknown mode
 */

import { describe, it, expect } from 'vitest';
import { ModeTrackerEngine } from '../engine.js';
import { serializeSnapshot } from '../persistence.js';
import type { ModeStateSnapshot, ModeTracker } from '../tracker.js';

/** Minimal tracker stub — stores the current state as a plain string. */
function makeTracker(
  id: string,
  state = 'inactive',
): ModeTracker<string, string, unknown> {
  let current = state;
  return {
    id,
    state: () => current,
    transition: (event) => {
      if (event === current) return false;
      current = event;
      return true;
    },
    canGateTools: () => current === 'active',
    shouldInjectReminder: () => current !== 'inactive',
    snapshot: () => ({ state: current }),
    restore: (raw) => {
      const data = raw as { state?: string } | null;
      if (!data || typeof data.state !== 'string') {
        throw new Error(`invalid snapshot for tracker "${id}"`);
      }
      current = data.state;
    },
  };
}

describe('ModeTrackerEngine', () => {
  it('registers trackers and exposes them via has/get/list', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));
    engine.register(makeTracker('goal'));

    expect(engine.has('plan')).toBe(true);
    expect(engine.has('goal')).toBe(true);
    expect(engine.has('unknown')).toBe(false);

    expect(engine.get('plan')?.id).toBe('plan');
    expect(engine.get('goal')?.id).toBe('goal');
    expect(engine.get('unknown')).toBeUndefined();

    expect(engine.list().map((t) => t.id).sort()).toEqual(['goal', 'plan']);
  });

  it('throws when registering a duplicate id', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));
    expect(() => engine.register(makeTracker('plan'))).toThrow(/already registered/);
  });

  it('collects persisted snapshots for all registered trackers', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan', 'active'));
    engine.register(makeTracker('goal', 'executing'));

    const snaps = engine.snapshots('sess-1');
    expect(snaps).toHaveLength(2);

    const planSnap = snaps.find((s) => s.mode === 'plan');
    expect(planSnap?.sessionId).toBe('sess-1');
    expect(planSnap?.status).toBe('active');
    expect(planSnap?.data).toEqual({ state: 'active' });
    expect(typeof planSnap?.updatedAt).toBe('number');

    const goalSnap = snaps.find((s) => s.mode === 'goal');
    expect(goalSnap?.status).toBe('executing');
    expect(goalSnap?.data).toEqual({ state: 'executing' });
  });

  it('restores a tracker from a snapshot when the mode is registered', () => {
    const engine = new ModeTrackerEngine();
    const plan = makeTracker('plan', 'inactive');
    engine.register(plan);

    const snap = serializeSnapshot(plan, 'sess-1', 123);
    // Overwrite the serialized payload to simulate an externally-observed state.
    snap.data = { state: 'active' };

    expect(engine.restore('sess-1', snap)).toBe(true);
    expect(plan.state()).toBe('active');
  });

  it('returns false when restoring an unregistered mode', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));

    const snap: ModeStateSnapshot = {
      mode: 'ghost',
      sessionId: 'sess-1',
      status: 'active',
      data: { state: 'active' },
      updatedAt: 1,
    };
    expect(engine.restore('sess-1', snap)).toBe(false);
  });
});
