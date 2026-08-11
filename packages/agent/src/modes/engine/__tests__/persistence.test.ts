/**
 * ModeTracker snapshot serialization — pure function tests (plan 413a).
 *
 * Covers:
 *   - serializeSnapshot produces the full ModeStateSnapshot shape
 *   - round-trip: serialize → applySnapshot restores the tracker state
 *   - snapshotStatus extracts the queryable status string
 *   - applySnapshot returns false (never throws) on a malformed payload
 */

import { describe, it, expect } from 'vitest';
import {
  applySnapshot,
  serializeSnapshot,
  snapshotStatus,
} from '../persistence.js';
import type { ModeStateSnapshot, ModeTracker } from '../tracker.js';

type AnyTracker = ModeTracker<string, string, unknown>;

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

describe('serializeSnapshot', () => {
  it('wraps a tracker snapshot into the uniform shape', () => {
    const tracker = makeTracker('plan', {
      state: () => 'active',
      snapshot: () => ({ status: 'active', steps: ['a', 'b'] }),
    });

    const snap = serializeSnapshot(tracker, 'session-9', 12345);

    expect(snap.mode).toBe('plan');
    expect(snap.sessionId).toBe('session-9');
    expect(snap.status).toBe('active');
    expect(snap.data).toEqual({ status: 'active', steps: ['a', 'b'] });
    expect(snap.updatedAt).toBe(12345);
  });
});

describe('snapshotStatus', () => {
  it('returns the queryable status string stored on the snapshot', () => {
    const snap: ModeStateSnapshot = {
      mode: 'plan',
      sessionId: 's',
      status: 'exit-pending',
      data: { status: 'exit-pending' },
      updatedAt: 1,
    };
    expect(snapshotStatus(snap)).toBe('exit-pending');
  });
});

describe('applySnapshot', () => {
  it('round-trips: restore returns a tracker to the state it was serialized in', () => {
    let current: { status: string } = { status: 'pending' };
    const tracker: AnyTracker = {
      id: 'plan',
      state: () => current.status,
      transition: () => false,
      canGateTools: () => false,
      shouldInjectReminder: () => false,
      snapshot: () => current,
      restore: (raw) => {
        current = raw as { status: string };
      },
    };

    const snap = serializeSnapshot(tracker, 's', 1);
    expect(snap.status).toBe('pending');

    // Simulate a crash in between: the live tracker drifts to another state.
    current = { status: 'active' };
    expect(tracker.state()).toBe('active');

    expect(applySnapshot(tracker, snap)).toBe(true);
    expect(tracker.state()).toBe('pending');
  });

  it('returns false and does not throw when the tracker rejects the payload', () => {
    const tracker = makeTracker('plan', {
      restore: () => {
        throw new Error('malformed');
      },
    });
    const snap: ModeStateSnapshot = {
      mode: 'plan',
      sessionId: 's',
      status: 'active',
      data: { bogus: true },
      updatedAt: 1,
    };

    expect(() => applySnapshot(tracker, snap)).not.toThrow();
    expect(applySnapshot(tracker, snap)).toBe(false);
  });
});
