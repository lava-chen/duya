/**
 * run-lifecycle-tracker.test.ts — small-kernel transition matrix +
 * predicate groups (plan 415 §6.2.7 test matrix as amended by 552
 * ruling #4; the matrix is the pure kernel, not a base class).
 */

import { describe, it, expect } from 'vitest';
import {
  transitionRunLifecycle,
  foldRestoredRunState,
  parseRunLifecycleState,
  parseRunHistory,
  pushRunHistory,
  isPausedRunState,
  isTerminalRunState,
  isResumableRunState,
  runNeedsTopUp,
  runStateCanGateTools,
  runStateShouldInjectReminder,
  pauseKindToState,
  RUN_HISTORY_CAP,
  RUN_LIFECYCLE_STATES,
  type RunLifecycleState,
} from '../run-lifecycle-tracker.js';

const ALL = RUN_LIFECYCLE_STATES;

function next(state: RunLifecycleState, event: Parameters<typeof transitionRunLifecycle>[1]) {
  return transitionRunLifecycle(state, event);
}

describe('transition matrix — happy paths (415 §6.2.3)', () => {
  it('inactive → planning on start', () => {
    const r = next('inactive', { type: 'start' });
    expect(r.handled).toBe(true);
    expect(r.next).toBe('planning');
  });

  it('planning → active / awaiting_confirm via plan_ready', () => {
    expect(next('planning', { type: 'plan_ready' }).next).toBe('active');
    expect(next('planning', { type: 'plan_ready', highRisk: true }).next).toBe('awaiting_confirm');
  });

  it('awaiting_confirm → active on confirm', () => {
    expect(next('awaiting_confirm', { type: 'confirm' }).next).toBe('active');
  });

  it('active ⇄ verifying and terminal outcomes', () => {
    expect(next('active', { type: 'report_verifiable' }).next).toBe('verifying');
    expect(next('verifying', { type: 'verdict', verdict: 'achieved' }).next).toBe('complete');
    expect(next('verifying', { type: 'verdict', verdict: 'not_achieved' }).next).toBe('active');
    expect(next('verifying', { type: 'verdict', verdict: 'blocked' }).next).toBe('blocked');
    expect(next('active', { type: 'complete' }).next).toBe('complete');
    expect(next('active', { type: 'budget_limit' }).next).toBe('budget_limited');
    expect(next('active', { type: 'interrupt' }).next).toBe('interrupted');
    expect(next('active', { type: 'fail' }).next).toBe('failed');
    expect(next('active', { type: 'cancel' }).next).toBe('cancelled');
    expect(next('active', { type: 'stall' }).next).toBe('no_progress_paused');
    expect(next('active', { type: 'infra_error' }).next).toBe('infra_paused');
  });

  it('paused family resumes to active; terminals reset via clear/start', () => {
    for (const p of ['user_paused', 'backoff_paused', 'no_progress_paused', 'infra_paused', 'blocked'] as const) {
      expect(next(p, { type: 'resume' }).next).toBe('active');
      expect(next(p, { type: 'complete' }).next).toBe('complete');
      expect(next(p, { type: 'clear' }).next).toBe('inactive');
    }
    expect(next('budget_limited', { type: 'clear' }).next).toBe('inactive');
    expect(next('complete', { type: 'clear' }).next).toBe('inactive');
    expect(next('cancelled', { type: 'clear' }).next).toBe('inactive');
    expect(next('cancelled', { type: 'start' }).next).toBe('planning');
    expect(next('interrupted', { type: 'resume' }).next).toBe('active');
    expect(next('failed', { type: 'resume' }).next).toBe('active');
  });
});

describe('pause kinds', () => {
  it('verification lands on blocked; others land per kind', () => {
    expect(pauseKindToState('verification')).toBe('blocked');
    expect(next('active', { type: 'pause', kind: 'verification' }).next).toBe('blocked');
    expect(next('active', { type: 'pause', kind: 'user' }).next).toBe('user_paused');
    expect(next('active', { type: 'pause', kind: 'back_off' }).next).toBe('backoff_paused');
    expect(next('verifying', { type: 'pause', kind: 'infra' }).next).toBe('infra_paused');
  });

  it('a paused run can switch pause kind; same kind is a no-op', () => {
    expect(next('user_paused', { type: 'pause', kind: 'back_off' }).next).toBe('backoff_paused');
    expect(next('user_paused', { type: 'pause', kind: 'user' }).handled).toBe(false);
  });
});

describe('illegal transitions', () => {
  it('each state refuses events outside its row (spot matrix)', () => {
    expect(next('inactive', { type: 'complete' }).handled).toBe(false);
    expect(next('inactive', { type: 'resume' }).handled).toBe(false);
    expect(next('complete', { type: 'cancel' }).handled).toBe(false);
    expect(next('cancelled', { type: 'resume' }).handled).toBe(false);
    expect(next('awaiting_confirm', { type: 'plan_ready' }).handled).toBe(false);
    expect(next('verifying', { type: 'plan_ready' }).handled).toBe(false);
    expect(next('budget_limited', { type: 'resume' }).handled).toBe(false);
  });
});

describe('group predicates (exhaustive)', () => {
  it('paused / terminal / resumable / top-up / gate / reminder', () => {
    for (const s of ALL) {
      expect(isPausedRunState(s)).toBe(
        ['user_paused', 'backoff_paused', 'no_progress_paused', 'infra_paused', 'blocked'].includes(s),
      );
      expect(isTerminalRunState(s)).toBe(
        ['budget_limited', 'complete', 'cancelled', 'interrupted', 'failed'].includes(s),
      );
      expect(isResumableRunState(s)).toBe(
        isPausedRunState(s) || s === 'failed' || s === 'interrupted',
      );
      expect(runNeedsTopUp(s)).toBe(s === 'budget_limited');
      expect(runStateCanGateTools(s)).toBe(s === 'active' || s === 'verifying');
      expect(runStateShouldInjectReminder(s)).toBe(s === 'active' || s === 'verifying');
    }
  });
});

describe('top-up resume (budget_limited)', () => {
  it('requires a positive budget; accepts one when provided', () => {
    expect(next('budget_limited', { type: 'resume' }).handled).toBe(false);
    expect(next('budget_limited', { type: 'resume', budget: 0 }).handled).toBe(false);
    expect(next('budget_limited', { type: 'resume', budget: 64 }).next).toBe('active');
  });
});

describe('anti-downgrade', () => {
  it('failed / interrupted / cancelled never accept complete', () => {
    for (const s of ['failed', 'interrupted', 'cancelled'] as const) {
      expect(next(s, { type: 'complete' }).handled).toBe(false);
    }
  });
});

describe('history cap + snapshot folding + sanitization', () => {
  it('history caps at 64 (grok MAX_HISTORY_ENTRIES)', () => {
    const entries: { at: number; event: string }[] = [];
    for (let i = 0; i < RUN_HISTORY_CAP + 20; i++) {
      pushRunHistory(entries, `e${i}`, undefined, i);
    }
    expect(entries.length).toBe(RUN_HISTORY_CAP);
    expect(entries[0].event).toBe('e20');
  });

  it('folds verifying → active, planning/awaiting_confirm → inactive', () => {
    expect(foldRestoredRunState('verifying')).toBe('active');
    expect(foldRestoredRunState('planning')).toBe('inactive');
    expect(foldRestoredRunState('awaiting_confirm')).toBe('inactive');
    expect(foldRestoredRunState('user_paused')).toBe('user_paused');
    expect(foldRestoredRunState('blocked')).toBe('blocked');
    expect(foldRestoredRunState('complete')).toBe('complete');
    expect(foldRestoredRunState('interrupted')).toBe('interrupted');
  });

  it('parseRunLifecycleState throws on unknown values', () => {
    expect(parseRunLifecycleState('active')).toBe('active');
    expect(() => parseRunLifecycleState('running')).toThrow();
    expect(() => parseRunLifecycleState(42)).toThrow();
  });

  it('parseRunHistory validates entries and caps', () => {
    expect(parseRunHistory([{ at: 1, event: 'start' }])).toHaveLength(1);
    expect(() => parseRunHistory('nope')).toThrow();
    expect(() => parseRunHistory([{}])).toThrow();
    const big = Array.from({ length: 100 }, (_, i) => ({ at: i, event: `e${i}` }));
    expect(parseRunHistory(big)).toHaveLength(RUN_HISTORY_CAP);
  });
});
