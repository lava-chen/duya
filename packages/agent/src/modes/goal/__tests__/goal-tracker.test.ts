/**
 * GoalTracker — 10-state goal mode state machine tests (plan 411 Phase 1).
 *
 * Verifies the full transition table (plan 411 §2.4), idempotency of
 * illegal/no-op events, snapshot()/restore() round-trips through the 413
 * persistence helpers (`serializeSnapshot`/`applySnapshot`), transient
 * fold semantics, history cap, token budget tracking, and the
 * shouldInjectReminder / canGateTools contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { GoalTracker, GOAL_HISTORY_CAP } from '../goal-tracker.js';
import { serializeSnapshot, applySnapshot } from '../../engine/persistence.js';
import { ModeTrackerEngine } from '../../engine/engine.js';
import type { ModeTracker } from '../../engine/tracker.js';
import { logger } from '../../../utils/logger.js';

describe('GoalTracker — happy path', () => {
  it('drives the lifecycle: idle → start → active/planning → report_completed → verifying → achieved → complete → clear → idle', () => {
    const t = new GoalTracker();
    expect(t.state()).toBe('idle');
    expect(t.phase()).toBe('idle');

    // idle --start--> active (planning)
    expect(t.transition({ type: 'start', objective: 'Migrate auth module' })).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.phase()).toBe('planning');
    expect(t.objective()).toBe('Migrate auth module');
    expect(t.shouldInjectReminder()).toBe(true);
    expect(t.canGateTools()).toBe(true);

    // planning → executing on first worker round
    t.recordWorkerRound();
    expect(t.phase()).toBe('executing');
    expect(t.totalWorkerRounds()).toBe(1);

    // active --report_completed--> verifying
    expect(t.transition({ type: 'report_completed' })).toBe(true);
    expect(t.state()).toBe('verifying');

    // verifying --verdict achieved--> complete
    expect(t.transition({ type: 'verdict', verdict: 'achieved' })).toBe(true);
    expect(t.state()).toBe('complete');
    expect(t.canGateTools()).toBe(false);
    expect(t.shouldInjectReminder()).toBe(false);
    expect(t.totalVerifyRounds()).toBe(1);

    // complete --clear--> idle
    expect(t.transition({ type: 'clear' })).toBe(true);
    expect(t.state()).toBe('idle');
    expect(t.objective()).toBe('');
  });

  it('returns to active on not_achieved and increments the streak', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Refactor parser' });
    t.transition({ type: 'report_completed' });

    expect(t.transition({ type: 'verdict', verdict: 'not_achieved' })).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.consecutiveNotAchieved()).toBe(1);
    expect(t.totalVerifyRounds()).toBe(1);

    // second round, re-report, not achieved again
    t.recordWorkerRound();
    t.transition({ type: 'report_completed' });
    t.transition({ type: 'verdict', verdict: 'not_achieved' });
    expect(t.consecutiveNotAchieved()).toBe(2);
  });

  it('lands in blocked on a blocked verdict', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Ship feature' });
    t.transition({ type: 'report_completed' });

    expect(t.transition({ type: 'verdict', verdict: 'blocked' })).toBe(true);
    expect(t.state()).toBe('blocked');
    // blocked can resume (user unblocks)
    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.state()).toBe('active');
  });
});

describe('GoalTracker — pause / resume / auto-pause', () => {
  it('pause from active → user_paused, records message; resume → active', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });

    expect(t.transition({ type: 'pause', message: 'need API key' })).toBe(true);
    expect(t.state()).toBe('user_paused');
    expect(t.pauseMessage()).toBe('need API key');
    expect(t.canGateTools()).toBe(false);
    expect(t.shouldInjectReminder()).toBe(false);

    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.state()).toBe('active');
  });

  it('pause is idempotent while already user_paused', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.transition({ type: 'pause' });

    expect(t.transition({ type: 'pause', message: 'again' })).toBe(false);
    expect(t.state()).toBe('user_paused');
  });

  it('stall → no_progress_paused, infra_error → infra_paused, both resume', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });

    expect(t.transition({ type: 'stall' })).toBe(true);
    expect(t.state()).toBe('no_progress_paused');
    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.state()).toBe('active');

    expect(t.transition({ type: 'infra_error' })).toBe(true);
    expect(t.state()).toBe('infra_paused');
    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.state()).toBe('active');
  });

  it('budget_limit → budget_limited; resume without a raised budget is a no-op, with one it continues', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X', budget: 100 });

    expect(t.transition({ type: 'budget_limit' })).toBe(true);
    expect(t.state()).toBe('budget_limited');
    expect(t.canGateTools()).toBe(false);

    // Resume without raising the budget: still trips (defense).
    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.tokenBudget()).toBe(100);
    expect(t.updateTokenUsage(150)).toBe(true); // still over → re-trips
    expect(t.transition({ type: 'budget_limit' })).toBe(true);
    expect(t.state()).toBe('budget_limited');

    // Resume WITH a raised budget continues past the old cap.
    expect(t.transition({ type: 'resume', budget: 1000 })).toBe(true);
    expect(t.state()).toBe('active');
    expect(t.tokenBudget()).toBe(1000);
    expect(t.updateTokenUsage(150)).toBe(false); // under the new cap
  });

  it('resume from a paused goal resets the stall counter', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.setGaps('same gaps', 'fp-A');
    t.setGaps('same gaps', 'fp-A');
    expect(t.classifierStallCount()).toBe(1);

    t.transition({ type: 'stall' }); // → no_progress_paused
    expect(t.state()).toBe('no_progress_paused');
    expect(t.transition({ type: 'resume' })).toBe(true);
    expect(t.classifierStallCount()).toBe(0);
  });
});

describe('GoalTracker — illegal transitions are idempotent', () => {
  it('rejects events from the wrong state without throwing', () => {
    const t = new GoalTracker();
    // idle: only start is valid
    expect(t.transition({ type: 'report_completed' })).toBe(false);
    expect(t.transition({ type: 'verdict', verdict: 'achieved' })).toBe(false);
    expect(t.transition({ type: 'resume' })).toBe(false);
    expect(t.transition({ type: 'clear' })).toBe(false); // already idle
    expect(t.state()).toBe('idle');

    // active: verdict is only valid from verifying
    t.transition({ type: 'start', objective: 'X' });
    expect(t.transition({ type: 'verdict', verdict: 'achieved' })).toBe(false);
    expect(t.transition({ type: 'report_completed' })).toBe(true);
    // verifying: report_completed is a no-op (already verifying)
    expect(t.transition({ type: 'report_completed' })).toBe(false);
    expect(t.state()).toBe('verifying');
  });

  it('rejects empty objectives on start', () => {
    const t = new GoalTracker();
    expect(t.transition({ type: 'start', objective: '   ' })).toBe(false);
    expect(t.state()).toBe('idle');
  });

  it('complete event forces completion from active', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    expect(t.transition({ type: 'complete' })).toBe(true);
    expect(t.state()).toBe('complete');
  });
});

describe('GoalTracker — snapshot / restore', () => {
  it('round-trips an active goal through serializeSnapshot → applySnapshot (folds to paused)', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Ship it', budget: 5000 });
    t.recordWorkerRound();
    t.transition({ type: 'report_completed' });
    t.transition({ type: 'verdict', verdict: 'not_achieved' });
    t.setGaps('tests still red', 'test-fail');
    t.recordWorkerRound();
    t.updateTokenUsage(1200);

    const snap = serializeSnapshot(t, 'sess-1', 1);
    const restored = new GoalTracker();
    expect(applySnapshot(restored, snap)).toBe(true);

    // grok from_snapshot safety: a cold restore of an active goal folds to
    // user_paused so the user explicitly resumes after a restart.
    expect(restored.state()).toBe('user_paused');
    expect(restored.phase()).toBe('executing');
    expect(restored.objective()).toBe('Ship it');
    expect(restored.tokenBudget()).toBe(5000);
    expect(restored.tokensUsedHighWater()).toBe(1200);
    expect(restored.totalWorkerRounds()).toBe(2);
    expect(restored.totalVerifyRounds()).toBe(1);
    expect(restored.consecutiveNotAchieved()).toBe(1);
    expect(restored.gapsSummary()).toBe('tests still red');
    expect(restored.gapFingerprint()).toBe('test-fail');
    // The user can resume the folded goal.
    expect(restored.transition({ type: 'resume' })).toBe(true);
    expect(restored.state()).toBe('active');
  });

  it('folds active and verifying → user_paused on cold restore (no unsupervised auto-resume)', () => {
    const active = new GoalTracker();
    active.transition({ type: 'start', objective: 'X' });
    expect(active.state()).toBe('active');
    const activeSnap = serializeSnapshot(active, 'sess-1', 1);
    const restoredActive = new GoalTracker();
    expect(applySnapshot(restoredActive, activeSnap)).toBe(true);
    expect(restoredActive.state()).toBe('user_paused');

    const verifying = new GoalTracker();
    verifying.transition({ type: 'start', objective: 'X' });
    verifying.transition({ type: 'report_completed' });
    expect(verifying.state()).toBe('verifying');
    const verifySnap = serializeSnapshot(verifying, 'sess-1', 1);
    const restoredVerifying = new GoalTracker();
    expect(applySnapshot(restoredVerifying, verifySnap)).toBe(true);
    expect(restoredVerifying.state()).toBe('user_paused');
  });

  it('does not clobber live in-memory state on a same-process restore', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Live goal' });
    t.transition({ type: 'report_completed' });
    // A stale snapshot says the goal was idle/cleared.
    const stale = new GoalTracker();
    stale.transition({ type: 'start', objective: 'old' });
    stale.transition({ type: 'clear' });
    const staleSnap = serializeSnapshot(stale, 'sess-1', 1);

    // The live tracker keeps its verifying state; the stale snapshot is
    // ignored because the tracker is not in its initial idle state.
    t.restore(staleSnap.data as Parameters<typeof t.restore>[0]);
    expect(t.state()).toBe('verifying');
    expect(t.objective()).toBe('Live goal');
  });

  it('preserves durable states (user_paused / complete / budget_limited)', () => {
    const paused = new GoalTracker();
    paused.transition({ type: 'start', objective: 'X' });
    paused.transition({ type: 'pause', message: 'waiting' });
    const pausedSnap = serializeSnapshot(paused, 'sess-1', 1);
    const restoredPaused = new GoalTracker();
    restoredPaused.restore(pausedSnap.data as Parameters<typeof restoredPaused.restore>[0]);
    expect(restoredPaused.state()).toBe('user_paused');
    expect(restoredPaused.pauseMessage()).toBe('waiting');

    const done = new GoalTracker();
    done.transition({ type: 'start', objective: 'X' });
    done.transition({ type: 'complete' });
    const doneSnap = serializeSnapshot(done, 'sess-1', 1);
    const restoredDone = new GoalTracker();
    restoredDone.restore(doneSnap.data as Parameters<typeof restoredDone.restore>[0]);
    expect(restoredDone.state()).toBe('complete');
  });

  it('rejects invalid snapshots without corrupting state', () => {
    const t = new GoalTracker();
    expect(() => t.restore({ state: 'bogus' } as never)).toThrow();
    expect(() => t.restore(null as never)).toThrow();
    // tracker still usable
    expect(t.state()).toBe('idle');
    expect(t.transition({ type: 'start', objective: 'X' })).toBe(true);
  });

  it('caps the history log at GOAL_HISTORY_CAP entries', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    for (let i = 0; i < GOAL_HISTORY_CAP + 10; i++) {
      t.transition({ type: 'report_completed' });
      t.transition({ type: 'verdict', verdict: 'not_achieved' });
    }
    expect(t.history().length).toBeLessThanOrEqual(GOAL_HISTORY_CAP);
  });
});

describe('GoalTracker — token budget', () => {
  it('updateTokenUsage raises the high-water mark and flags over-budget', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X', budget: 1000 });

    expect(t.updateTokenUsage(500)).toBe(false);
    expect(t.tokensUsedHighWater()).toBe(500);

    expect(t.updateTokenUsage(300)).toBe(false); // below high water
    expect(t.tokensUsedHighWater()).toBe(500);

    expect(t.updateTokenUsage(1000)).toBe(true); // exactly at budget
    expect(t.updateTokenUsage(1500)).toBe(true); // over budget
    expect(t.tokensUsedHighWater()).toBe(1500);
  });

  it('no budget (0) never flags over-budget', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    expect(t.updateTokenUsage(10_000_000)).toBe(false);
  });
});

describe('GoalTracker — engine registration', () => {
  it('registers the singleton and collects its snapshot', () => {
    const engine = new ModeTrackerEngine();
    engine.register(goalStub());
    engine.register(goalTrackerUpcast());

    const snaps = engine.snapshots('sess-1');
    const goalSnap = snaps.find((s) => s.mode === 'goal');
    expect(goalSnap).toBeDefined();
    expect(goalSnap?.status).toBe('active');
  });
});

/** Generic string-event tracker stub (engine requires string-typed events). */
function goalStub(): ModeTracker<string, string, unknown> {
  return {
    id: 'stub',
    state: () => 'inactive',
    transition: () => false,
    canGateTools: () => false,
    shouldInjectReminder: () => false,
    snapshot: () => ({ state: 'inactive' }),
    restore: () => undefined,
  };
}

/** Upcast a concrete GoalTracker to the engine's existential tracker shape. */
function goalTrackerUpcast(): ModeTracker<string, string, unknown> {
  const t = new GoalTracker();
  t.transition({ type: 'start', objective: 'Engine probe' });
  return t as unknown as ModeTracker<string, string, unknown>;
}

describe('GoalTracker logging', () => {
  it('logs a state migration on start', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const t = new GoalTracker();
    const changed = t.transition({ type: 'start', objective: 'ship it' });
    expect(changed).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([msg]) => String(msg).includes('[Goal]'))).toBe(true);
    spy.mockRestore();
  });
});
