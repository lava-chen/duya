/**
 * ModeTracker persistence tests.
 *
 * Pure serialization (plan 413a):
 *   - serializeSnapshot produces a well-formed ModeStateSnapshot
 *   - round-trip serialize → applySnapshot restores tracker state
 *   - invalid snapshots (null data, mode mismatch, throwing restore)
 *     yield false without throwing
 *   - snapshotStatus surfaces the persisted status column
 *
 * IPC-bound disk persistence (plan 413c):
 *   - persistSnapshot serializes and calls modeStateDb.upsert
 *   - persistSnapshot swallows a failing upsert and logs a warning
 *   - restoreTracker restores from a persisted row
 *   - restoreTracker returns false for missing row / corrupt blob / DB failure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applySnapshot,
  serializeSnapshot,
  snapshotStatus,
  persistSnapshot,
  restoreTracker,
} from '../persistence.js';
import type { ModeStateSnapshot, ModeTracker } from '../tracker.js';

// Mock the IPC-bound db-client + logger so the persist/restore tests exercise
// the degradation path without a live IPC channel (plan 413c). The pure
// serialization describe blocks above are unaffected — they never touch
// modeStateDb.
const mocks = vi.hoisted(() => ({
  modeStateDb: {
    get: vi.fn(),
    upsert: vi.fn(),
    setStatus: vi.fn(),
    listBySession: vi.fn(),
  },
  logger: { warn: vi.fn() },
}));

vi.mock('../../../ipc/db-client.js', () => ({ modeStateDb: mocks.modeStateDb }));
vi.mock('../../../utils/logger.js', () => ({ logger: mocks.logger }));

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

// ─── Disk persistence (plan 413c) ───

describe('persistSnapshot', () => {
  beforeEach(() => {
    mocks.modeStateDb.upsert.mockReset();
    mocks.logger.warn.mockReset();
  });

  it('serializes the tracker and persists the full snapshot via modeStateDb.upsert', async () => {
    const tracker = makePlanLikeTracker('plan-task', 'active', 4);
    await persistSnapshot(tracker, 'sess-1');

    expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1);
    const input = mocks.modeStateDb.upsert.mock.calls[0][0];
    expect(input.sessionId).toBe('sess-1');
    expect(input.mode).toBe('plan-task');
    expect(input.status).toBe('active');
    expect(input.reminderCount).toBe(4);

    const parsed = JSON.parse(input.snapshotJson) as ModeStateSnapshot;
    expect(parsed.mode).toBe('plan-task');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.status).toBe('active');
    expect(parsed.data).toEqual({ state: 'active', reminderCount: 4 });
    expect(typeof parsed.updatedAt).toBe('number');
  });

  it('defaults reminder_count to 0 when the snapshot carries none', async () => {
    const tracker = makeTracker('goal-mode', 'active');
    await persistSnapshot(tracker, 'sess-1');

    const input = mocks.modeStateDb.upsert.mock.calls[0][0];
    expect(input.reminderCount).toBe(0);
  });

  it('swallows a failing upsert and logs a warning (never throws)', async () => {
    const tracker = makeTracker('plan-task', 'active');
    mocks.modeStateDb.upsert.mockRejectedValueOnce(new Error('IPC down'));

    await expect(persistSnapshot(tracker, 'sess-1')).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn.mock.calls[0][0]).toContain('persist failed');
  });
});

describe('restoreTracker', () => {
  beforeEach(() => {
    mocks.modeStateDb.get.mockReset();
    mocks.logger.warn.mockReset();
  });

  it('restores a tracker from the persisted row', async () => {
    const snap = serializeSnapshot(makePlanLikeTracker('plan-task', 'active', 3), 'sess-1', 42);
    mocks.modeStateDb.get.mockResolvedValueOnce({
      sessionId: 'sess-1',
      mode: 'plan-task',
      status: snap.status,
      reminderCount: 3,
      snapshotJson: JSON.stringify(snap),
      updatedAt: 42,
    });

    const restored = makeTracker('plan-task', 'inactive');
    await expect(restoreTracker(restored, 'sess-1')).resolves.toBe(true);
    expect(restored.state()).toBe('active');
  });

  it('returns false when no row exists', async () => {
    mocks.modeStateDb.get.mockResolvedValueOnce(null);

    const tracker = makeTracker('plan-task', 'inactive');
    await expect(restoreTracker(tracker, 'sess-1')).resolves.toBe(false);
    expect(tracker.state()).toBe('inactive');
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('returns false on a corrupt snapshot blob', async () => {
    mocks.modeStateDb.get.mockResolvedValueOnce({
      sessionId: 'sess-1',
      mode: 'plan-task',
      status: 'active',
      reminderCount: 0,
      snapshotJson: 'not-json{{{',
      updatedAt: 1,
    });

    const tracker = makeTracker('plan-task', 'inactive');
    await expect(restoreTracker(tracker, 'sess-1')).resolves.toBe(false);
    expect(tracker.state()).toBe('inactive');
  });

  it('returns false and logs a warning when the DB read fails', async () => {
    mocks.modeStateDb.get.mockRejectedValueOnce(new Error('IPC down'));

    const tracker = makeTracker('plan-task', 'inactive');
    await expect(restoreTracker(tracker, 'sess-1')).resolves.toBe(false);
    expect(tracker.state()).toBe('inactive');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn.mock.calls[0][0]).toContain('restore failed');
  });

  it('returns false when the tracker refuses the snapshot (mode mismatch)', async () => {
    const snap = serializeSnapshot(makePlanLikeTracker('plan-task', 'active', 0), 'sess-1', 42);
    mocks.modeStateDb.get.mockResolvedValueOnce({
      sessionId: 'sess-1',
      mode: 'plan-task',
      status: snap.status,
      reminderCount: 0,
      snapshotJson: JSON.stringify(snap),
      updatedAt: 42,
    });

    const tracker = makeTracker('goal-mode', 'inactive');
    await expect(restoreTracker(tracker, 'sess-1')).resolves.toBe(false);
    expect(tracker.state()).toBe('inactive');
  });
});

/**
 * A plan-like tracker whose snapshot carries `reminderCount`, exercising the
 * plan-specific mirror column logic in `persistSnapshot`.
 */
function makePlanLikeTracker(
  id: string,
  state: string,
  reminderCount: number,
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
    snapshot: () => ({ state: current, reminderCount }),
    restore: (raw) => {
      const data = raw as { state?: string } | null;
      if (!data || typeof data.state !== 'string') throw new Error('invalid snapshot');
      current = data.state;
    },
  };
}
