/**
 * ModeTrackerEngine — registration / snapshot collection tests (plan 413a).
 *
 * Covers:
 *   - register + has/get/list
 *   - duplicate-id registration throws
 *   - snapshots() collects one ModeStateSnapshot per tracker
 *   - restore() hits when the tracker exists, misses otherwise, and surfaces
 *     a tracker's rejection of a malformed payload as `false`
 */

import { describe, it, expect } from 'vitest';
import { ModeTrackerEngine } from '../engine.js';
import type { ModeStateSnapshot, ModeTracker } from '../tracker.js';

type AnyTracker = ModeTracker<string, string, unknown>;

/** Minimal tracker builder for tests — only sets id + the given overrides. */
function makeTracker(
  id: string,
  overrides: Partial<AnyTracker> = {},
): AnyTracker {
  return {
    id,
    state: () => 'idle',
    transition: () => false,
    canGateTools: () => false,
    shouldInjectReminder: () => false,
    snapshot: () => ({ status: 'idle' }),
    restore: () => undefined,
    ...overrides,
  };
}

function makeSnap(overrides: Partial<ModeStateSnapshot> = {}): ModeStateSnapshot {
  return {
    mode: 'plan',
    sessionId: 'session-1',
    status: 'active',
    data: { status: 'active' },
    updatedAt: 1,
    ...overrides,
  };
}

describe('ModeTrackerEngine.register', () => {
  it('registers a tracker and exposes it via has/get/list', () => {
    const engine = new ModeTrackerEngine();
    const tracker = makeTracker('plan');

    engine.register(tracker);

    expect(engine.has('plan')).toBe(true);
    expect(engine.has('goal')).toBe(false);
    expect(engine.get('plan')).toBe(tracker);
    expect(engine.get('goal')).toBeUndefined();
    expect(engine.list()).toEqual([tracker]);
  });

  it('throws when the same id is registered twice', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));
    expect(() => engine.register(makeTracker('plan'))).toThrow(
      /already registered/,
    );
  });

  it('lists trackers in registration order', () => {
    const engine = new ModeTrackerEngine();
    const a = makeTracker('a');
    const b = makeTracker('b');
    engine.register(a);
    engine.register(b);
    expect(engine.list().map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('ModeTrackerEngine.snapshots', () => {
  it('collects one persisted snapshot per tracker with the session id and current state', () => {
    const engine = new ModeTrackerEngine();
    engine.register(
      makeTracker('plan', {
        state: () => 'active',
        snapshot: () => ({ status: 'active', plan: 'step-1' }),
      }),
    );
    engine.register(makeTracker('goal'));

    const snaps = engine.snapshots('session-42');

    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.mode).sort()).toEqual(['goal', 'plan']);

    const planSnap = snaps.find((s) => s.mode === 'plan')!;
    expect(planSnap.sessionId).toBe('session-42');
    expect(planSnap.status).toBe('active');
    expect(planSnap.data).toEqual({ status: 'active', plan: 'step-1' });
    expect(typeof planSnap.updatedAt).toBe('number');

    const goalSnap = snaps.find((s) => s.mode === 'goal')!;
    expect(goalSnap.status).toBe('idle');
  });

  it('returns an empty array when no tracker is registered', () => {
    const engine = new ModeTrackerEngine();
    expect(engine.snapshots('session-1')).toEqual([]);
  });
});

describe('ModeTrackerEngine.restore', () => {
  it('restores a tracker from its snapshot', () => {
    const restored: unknown[] = [];
    const engine = new ModeTrackerEngine();
    engine.register(
      makeTracker('plan', {
        restore: (raw) => {
          restored.push(raw);
        },
      }),
    );

    const snap = makeSnap({ data: { status: 'active' } });
    const ok = engine.restore('session-1', snap);

    expect(ok).toBe(true);
    expect(restored).toEqual([{ status: 'active' }]);
  });

  it('returns false when no tracker matches the snapshot mode', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));

    expect(engine.restore('session-1', makeSnap({ mode: 'unknown' }))).toBe(
      false,
    );
  });

  it('returns false (and does not throw) when the tracker rejects the payload', () => {
    const engine = new ModeTrackerEngine();
    engine.register(
      makeTracker('plan', {
        restore: () => {
          throw new Error('malformed snapshot');
        },
      }),
    );

    const snap = makeSnap({ data: { bogus: true } });
    expect(() => engine.restore('session-1', snap)).not.toThrow();
    expect(engine.restore('session-1', snap)).toBe(false);
  });
});
