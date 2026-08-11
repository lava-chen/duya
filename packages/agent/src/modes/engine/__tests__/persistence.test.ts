/**
 * ModeTracker persistence helpers — pure serialization tests (plan 413a).
 *
 * Covers:
 *   - serializeSnapshot produces a well-formed ModeStateSnapshot
 *   - round-trip serialize → applySnapshot restores tracker state
 *   - invalid snapshots (null data, mode mismatch, throwing restore)
 *     yield false without throwing
 *   - snapshotStatus surfaces the persisted status column
 */

import { describe, it, expect } from 'vitest';
import { applySnapshot, serializeSnapshot, snapshotStatus } from '../persistence.js';
import type { ModeStateSnapshot, ModeTracker } from '../tracker.js';

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

describe('serializeSnapshot', () => {
  it('wraps tracker state into a unified snapshot', () => {
    const tracker = makeTracker('plan', 'active');
    const snap = serializeSnapshot(tracker, 'sess-1', 42);

    expect(snap.mode).toBe('plan');
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.status).toBe('active');
    expect(snap.data).toEqual({ state: 'active' });
    expect(snap.updatedAt).toBe(42);
  });
});

describe('snapshotStatus', () => {
  it('surfaces the persisted status column', () => {
    const snap = serializeSnapshot(makeTracker('plan', 'pending'), 'sess-1', 1);
    expect(snapshotStatus(snap)).toBe('pending');
  });
});

describe('applySnapshot', () => {
  it('round-trips serialize → applySnapshot and restores tracker state', () => {
    const tracker = makeTracker('plan', 'active');
    const snap = serializeSnapshot(tracker, 'sess-1', 1);

    const restored = makeTracker('plan', 'inactive');
    expect(applySnapshot(restored, snap)).toBe(true);
    expect(restored.state()).toBe('active');
  });

  it('returns false for null/undefined data without throwing', () => {
    const tracker = makeTracker('plan');
    const snap: ModeStateSnapshot = {
      mode: 'plan',
      sessionId: 'sess-1',
      status: 'active',
      data: null,
      updatedAt: 1,
    };
    expect(applySnapshot(tracker, snap)).toBe(false);
    // tracker untouched
    expect(tracker.state()).toBe('inactive');
  });

  it('returns false when snapshot mode mismatches the tracker id', () => {
    const tracker = makeTracker('plan');
    const snap: ModeStateSnapshot = {
      mode: 'goal',
      sessionId: 'sess-1',
      status: 'active',
      data: { state: 'active' },
      updatedAt: 1,
    };
    expect(applySnapshot(tracker, snap)).toBe(false);
    expect(tracker.state()).toBe('inactive');
  });

  it('reports a throwing restore as false (never propagates)', () => {
    const throwing: ModeTracker<string, string, unknown> = {
      id: 'plan',
      state: () => 'inactive',
      transition: () => true,
      canGateTools: () => false,
      shouldInjectReminder: () => false,
      snapshot: () => ({ state: 'inactive' }),
      restore: () => {
        throw new Error('rejected snapshot shape');
      },
    };

    const snap: ModeStateSnapshot = {
      mode: 'plan',
      sessionId: 'sess-1',
      status: 'active',
      data: { bogus: true },
      updatedAt: 1,
    };
    expect(() => applySnapshot(throwing, snap)).not.toThrow();
    expect(applySnapshot(throwing, snap)).toBe(false);
  });
});
