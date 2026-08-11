/**
 * PlanModeTracker state-machine migration matrix (plan 413b).
 *
 * Mirrors grok's `plan_mode.rs` unit tests (adapted to the `transition(event,
 * payload)` API) plus the folding / round-trip / idempotency extensions listed
 * in plan 413b §2.8.
 */

import { describe, it, expect } from 'vitest';
import { PlanModeTracker } from '../plan-tracker.js';

function fresh(): PlanModeTracker {
  return new PlanModeTracker();
}

describe('PlanModeTracker lifecycle', () => {
  it('user-driven lifecycle: inactive → pending → active → inactive', () => {
    const t = fresh();
    expect(t.state()).toBe('inactive');

    expect(t.transition('enter')).toBe(true);
    expect(t.state()).toBe('pending');

    expect(t.transition('activate')).toBe(true);
    expect(t.state()).toBe('active');

    expect(t.transition('exit_approved')).toBe(true);
    expect(t.state()).toBe('inactive');
  });

  it('user_exit while a turn is in flight defers to exit_pending; restore completes it', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');

    expect(t.transition('user_exit', { turnInFlight: true })).toBe(true);
    expect(t.state()).toBe('exit_pending');

    // The deferred exit completes via snapshot folding (§2.4): restoring an
    // exit_pending snapshot lands on inactive with an exit reminder queued.
    const snap = t.snapshot();
    expect(snap.state).toBe('exit_pending');

    const restored = fresh();
    restored.restore(snap);
    expect(restored.state()).toBe('inactive');
    expect(restored.hasPendingExitReminder()).toBe(true);
  });

  it('pending cancel is clean: no exit reminder', () => {
    const t = fresh();
    t.transition('enter');

    expect(t.transition('user_exit')).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.hasPendingExitReminder()).toBe(false);
  });

  it('agent-driven activation from tool skips pending', () => {
    const t = fresh();
    expect(t.transition('activate_from_tool')).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.canGateTools()).toBe(true);
  });

  it('reentry is detected after an approved exit', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');
    t.transition('exit_approved');

    t.transition('enter');
    expect(t.isReentry()).toBe(true);
  });
});

describe('PlanModeTracker reminder alternation', () => {
  it('flips full/sparse with recordReminderInjected', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');

    expect(t.shouldUseFullReminder()).toBe(true);
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false);
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(true);
  });

  it('compaction resets the alternation back to full', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false);

    t.resetAfterCompaction();
    expect(t.shouldUseFullReminder()).toBe(true);
  });

  it('mid-turn activation buffers a reminder delivered exactly once', () => {
    const t = fresh();
    t.transition('enter');

    expect(
      t.transition('activate_mid_turn', { renderedReminder: 'reminder text' }),
    ).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.hasPendingActivation()).toBe(true);
    // Activation resets the counter, so the buffered reminder is a full one.
    expect(t.shouldUseFullReminder()).toBe(true);

    expect(t.takePendingActivation()).toBe('reminder text');
    expect(t.hasPendingActivation()).toBe(false);

    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false);
    expect(t.takePendingActivation()).toBeNull();
  });
});

describe('PlanModeTracker snapshot folding & round-trip', () => {
  it('serialize(pending) → restore → inactive; serialize(exit_pending) → restore → inactive + exit reminder', () => {
    const pending = fresh();
    pending.transition('enter');
    const r1 = fresh();
    r1.restore(pending.snapshot());
    expect(r1.state()).toBe('inactive');

    const exiting = fresh();
    exiting.transition('enter');
    exiting.transition('activate');
    exiting.transition('user_exit', { turnInFlight: true });
    const r2 = fresh();
    r2.restore(exiting.snapshot());
    expect(r2.state()).toBe('inactive');
    expect(r2.hasPendingExitReminder()).toBe(true);
  });

  it('active snapshot round-trips state / wasPreviouslyActive / reminderCount', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');
    t.recordReminderInjected();
    t.setAwaitingPlanApproval(true);

    const restored = fresh();
    restored.restore(t.snapshot());

    expect(restored.state()).toBe('active');
    expect(restored.shouldUseFullReminder()).toBe(false); // reminderCount 1 preserved
    expect(restored.isAwaitingPlanApproval()).toBe(true);

    // wasPreviouslyActive survived the round-trip: the next enter is a reentry.
    restored.transition('exit_approved');
    restored.transition('enter');
    expect(restored.isReentry()).toBe(true);
  });

  it('malformed snapshots throw so applySnapshot can report false', () => {
    const t = fresh();
    expect(() =>
      t.restore({ state: 'bogus' } as never),
    ).toThrow(TypeError);
    expect(() =>
      t.restore({ state: 'active', wasPreviouslyActive: 'yes' } as never),
    ).toThrow(TypeError);
  });
});

describe('PlanModeTracker transition idempotency', () => {
  it('repeated enter/activate are no-ops that keep the state stable', () => {
    const t = fresh();
    expect(t.transition('enter')).toBe(true);
    expect(t.transition('enter')).toBe(false);
    expect(t.state()).toBe('pending');

    expect(t.transition('activate')).toBe(true);
    expect(t.transition('activate')).toBe(false);
    expect(t.state()).toBe('active');

    // user_exit with no pending activation is also a no-op.
    expect(t.transition('user_exit')).toBe(true); // → inactive + exit reminder
    expect(t.transition('user_exit')).toBe(false);
    expect(t.state()).toBe('inactive');
  });
});

describe('PlanModeTracker user_exit rollback & re-entry', () => {
  it('withdraws an undelivered mid-turn activation instead of deferring an exit', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate_mid_turn', { renderedReminder: 'text' });

    expect(t.transition('user_exit', { turnInFlight: true })).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.hasPendingActivation()).toBe(false);
    expect(t.hasPendingExitReminder()).toBe(false);

    // A rolled-back activation does not fake a reentry.
    t.transition('enter');
    expect(t.isReentry()).toBe(false);
  });

  it('re-entering from exit_pending cancels the deferred exit and returns to active', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');
    t.transition('user_exit', { turnInFlight: true });
    expect(t.state()).toBe('exit_pending');

    expect(t.transition('enter')).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.hasPendingExitReminder()).toBe(false);
  });

  it('idle user_exit from active queues a one-shot exit reminder', () => {
    const t = fresh();
    t.transition('enter');
    t.transition('activate');

    expect(t.transition('user_exit')).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.hasPendingExitReminder()).toBe(true);

    t.clearPendingExitReminder();
    expect(t.hasPendingExitReminder()).toBe(false);
  });
});
