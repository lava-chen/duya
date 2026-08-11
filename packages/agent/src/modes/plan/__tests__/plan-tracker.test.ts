/**
 * PlanModeTracker — 4-state state machine tests (plan 413b).
 *
 * Mirrors grok's `plan_mode.rs` test suite (8 cases) plus duya-specific
 * snapshot-fold and idempotency coverage (11 cases total). Verifies the
 * full transition table, reminder alternation, mid-turn buffering,
 * snapshot fold/round-trip, and idempotency.
 */

import { describe, it, expect } from 'vitest';
import { PlanModeTracker } from '../plan-tracker.js';
import { serializeSnapshot } from '../../engine/persistence.js';
import type { PlanModeSnapshot } from '../plan-tracker.js';

describe('PlanModeTracker', () => {
  it('drives the user lifecycle: enter → pending → activate → active → exit_approved → inactive', () => {
    const t = new PlanModeTracker();
    expect(t.state()).toBe('inactive');

    expect(t.transition('enter')).toBe(true);
    expect(t.state()).toBe('pending');
    expect(t.shouldInjectReminder()).toBe(true);

    expect(t.transition('activate')).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.canGateTools()).toBe(true);

    expect(t.transition('exit_approved')).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.canGateTools()).toBe(false);
  });

  it('defers user_exit mid-turn: active → exit_pending → completeDeferredExit → inactive + exit reminder', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    t.transition('activate');

    expect(t.transition('user_exit', { inFlight: true })).toBe(true);
    expect(t.state()).toBe('exit_pending');
    expect(t.hasPendingExitReminder()).toBe(false);

    // Round-end: the in-flight turn finished.
    expect(t.completeDeferredExit()).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.hasPendingExitReminder()).toBe(true);
    expect(t.shouldInjectReminder()).toBe(true);
  });

  it('cancels cleanly from pending: user_exit → inactive with no exit reminder', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    expect(t.state()).toBe('pending');

    expect(t.transition('user_exit', { inFlight: false })).toBe(true);
    expect(t.state()).toBe('inactive');
    expect(t.hasPendingExitReminder()).toBe(false);
    expect(t.shouldInjectReminder()).toBe(false);
  });

  it('skips pending via tool activation: activate_from_tool → active', () => {
    const t = new PlanModeTracker();
    expect(t.transition('activate_from_tool')).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.canGateTools()).toBe(true);
  });

  it('detects re-entry into plan mode', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    t.transition('activate');
    t.transition('exit_approved');
    t.transition('enter');

    expect(t.state()).toBe('pending');
    expect(t.isReentry()).toBe(true);
  });

  it('alternates full/sparse reminders as reminders are recorded', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    t.transition('activate');

    expect(t.shouldUseFullReminder()).toBe(true); // 0 → full
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false); // 1 → sparse
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(true); // 2 → full
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false); // 3 → sparse
  });

  it('resetAfterCompaction restarts the alternation at full', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    t.transition('activate');
    t.recordReminderInjected();
    t.recordReminderInjected();
    t.recordReminderInjected();
    expect(t.shouldUseFullReminder()).toBe(false); // 3 → sparse

    t.resetAfterCompaction();
    expect(t.shouldUseFullReminder()).toBe(true); // 0 → full
  });

  it('buffers a mid-turn activation and delivers it exactly once', () => {
    const t = new PlanModeTracker();
    t.transition('enter');

    expect(t.transition('activate_mid_turn', { reminderText: 'mid-turn reminder' })).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.hasPendingActivation()).toBe(true);

    expect(t.takePendingActivation()).toBe('mid-turn reminder');
    expect(t.hasPendingActivation()).toBe(false);
    expect(t.takePendingActivation()).toBeNull();
  });

  it('folds transient states on restore: pending → inactive, exit_pending → inactive + exit reminder', () => {
    // pending folds to inactive (fresh enter required after restart).
    const pending = new PlanModeTracker();
    pending.transition('enter');
    const pendingSnap = serializeSnapshot(pending, 'sess-1', 1);
    const restoredPending = new PlanModeTracker();
    restoredPending.restore(pendingSnap.data as PlanModeSnapshot);
    expect(restoredPending.state()).toBe('inactive');
    expect(restoredPending.hasPendingExitReminder()).toBe(false);

    // exit_pending folds to inactive and arms the exit reminder.
    const exitPending = new PlanModeTracker();
    exitPending.transition('enter');
    exitPending.transition('activate');
    exitPending.transition('user_exit', { inFlight: true });
    expect(exitPending.state()).toBe('exit_pending');
    const exitSnap = serializeSnapshot(exitPending, 'sess-1', 1);
    const restoredExit = new PlanModeTracker();
    restoredExit.restore(exitSnap.data as PlanModeSnapshot);
    expect(restoredExit.state()).toBe('inactive');
    expect(restoredExit.hasPendingExitReminder()).toBe(true);
  });

  it('round-trips a stable active state through serialize → restore', () => {
    const t = new PlanModeTracker();
    t.transition('enter');
    t.transition('activate');
    t.recordReminderInjected();

    const snap = serializeSnapshot(t, 'sess-1', 1);
    const restored = new PlanModeTracker();
    restored.restore(snap.data as PlanModeSnapshot);

    expect(restored.state()).toBe('active');
    expect(restored.snapshot()).toEqual(t.snapshot());
    expect(restored.canGateTools()).toBe(true);
  });

  it('rejects invalid snapshots without corrupting state', () => {
    const t = new PlanModeTracker();
    expect(() => t.restore({ state: 'bogus' } as unknown as PlanModeSnapshot)).toThrow();
    expect(() => t.restore(null as unknown as PlanModeSnapshot)).toThrow();
    // tracker still usable afterwards
    expect(t.state()).toBe('inactive');
    expect(t.transition('enter')).toBe(true);
  });

  it('transition is idempotent: illegal repeats return false and do not drift', () => {
    const t = new PlanModeTracker();
    // activate from inactive is illegal
    expect(t.transition('activate')).toBe(false);
    expect(t.state()).toBe('inactive');

    expect(t.transition('enter')).toBe(true);
    expect(t.state()).toBe('pending');
    // repeated enter in pending is illegal
    expect(t.transition('enter')).toBe(false);
    expect(t.state()).toBe('pending');

    expect(t.transition('activate')).toBe(true);
    expect(t.state()).toBe('active');
    // repeated activate in active is illegal
    expect(t.transition('activate')).toBe(false);
    expect(t.state()).toBe('active');
  });
});
