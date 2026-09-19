/**
 * workflow-run-tracker.test.ts — WorkflowRunTracker behaviors on top of
 * the shared kernel (plan 415 §6.3 + 552 §6.5): budget consumption,
 * phase bookkeeping, execution epoch, journal pinning, wait parking,
 * snapshot round-trip with fold semantics, and the same-process guard.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowRunTracker } from '../tracker.js';
import type { WorkflowRunSnapshot } from '../tracker.js';

function activeTracker(budget = 4): WorkflowRunTracker {
  const t = new WorkflowRunTracker();
  t.transition({ type: 'start', objective: 'invoice-sync', budget });
  t.transition({ type: 'plan_ready' });
  return t;
}

describe('lifecycle via kernel', () => {
  it('start → planning → plan_ready → active; predicates live', () => {
    const t = new WorkflowRunTracker();
    expect(t.state()).toBe('inactive');
    t.transition({ type: 'start', objective: 'wf', budget: 8 });
    expect(t.state()).toBe('planning');
    expect(t.canGateTools()).toBe(false);
    t.transition({ type: 'plan_ready' });
    expect(t.state()).toBe('active');
    expect(t.canGateTools()).toBe(true);
    expect(t.shouldInjectReminder()).toBe(true);
    expect(t.workflowName()).toBe('wf');
  });

  it('high-risk plans stop at awaiting_confirm until confirm', () => {
    const t = new WorkflowRunTracker();
    t.transition({ type: 'start', objective: 'wf' });
    t.transition({ type: 'plan_ready', highRisk: true });
    expect(t.state()).toBe('awaiting_confirm');
    t.transition({ type: 'confirm' });
    expect(t.state()).toBe('active');
  });

  it('human suspension parks on blocked and resumes free', () => {
    const t = activeTracker();
    t.transition({ type: 'pause', kind: 'verification', message: 'awaiting approval: approve-payment' });
    expect(t.state()).toBe('blocked');
    expect(t.isPaused()).toBe(true);
    expect(t.pauseMessage()).toContain('approve-payment');
    t.transition({ type: 'resume' });
    expect(t.state()).toBe('active');
  });

  it('budget_limited refuses a free resume (top-up required)', () => {
    const t = activeTracker();
    t.transition({ type: 'budget_limit' });
    expect(t.needsTopUp()).toBe(true);
    expect(t.transition({ type: 'resume' })).toBe(false);
    expect(t.state()).toBe('budget_limited');
    t.transition({ type: 'resume', budget: 16 });
    expect(t.state()).toBe('active');
    expect(t.budgetLimit()).toBe(16);
  });
});

describe('agent-call budget (plan 552 §6.5 counter of record)', () => {
  it('consume/release bookkeeping trips the budget', () => {
    const t = activeTracker(2);
    expect(t.consumeAgentCall()).toBe(true);
    expect(t.consumeAgentCall()).toBe(true);
    expect(t.consumeAgentCall()).toBe(false);
    expect(t.agentsUsed()).toBe(2);
    t.releaseAgentCall();
    expect(t.agentsUsed()).toBe(1);
    expect(t.consumeAgentCall()).toBe(true);
  });
});

describe('phase / epoch / journal bookkeeping', () => {
  it('enterPhase + bumpEpoch track run progress', () => {
    const t = activeTracker();
    t.enterPhase(0, 'work');
    expect(t.currentPhase()).toEqual({ index: 0, id: 'work' });
    const e1 = t.bumpEpoch();
    const e2 = t.bumpEpoch();
    expect(e2).toBe(e1 + 1);
    expect(t.executionEpoch()).toBe(e2);
  });

  it('setJournalRef / setVersionId / parkUntil / waitTill', () => {
    const t = activeTracker();
    t.setJournalRef('/runs/r1/journal.jsonl');
    t.setVersionId('v3');
    t.parkUntil(123456);
    expect(t.journalRef()).toBe('/runs/r1/journal.jsonl');
    expect(t.waitTill()).toBe(123456);
    t.transition({ type: 'complete' });
    expect(t.waitTill()).toBeUndefined();
  });
});

describe('snapshot / restore', () => {
  it('round-trips and folds half-open states', () => {
    const t = activeTracker(6);
    t.enterPhase(1, 'verify');
    t.setJournalRef('/j');
    t.transition({ type: 'report_verifiable' });
    const snap = t.snapshot();
    expect(snap.state).toBe('verifying');

    const fresh = new WorkflowRunTracker();
    fresh.restore(snap);
    expect(fresh.state()).toBe('active');
    expect(fresh.agentsUsed()).toBe(0);
    expect(fresh.budgetLimit()).toBe(6);
    expect(fresh.currentPhase().id).toBe('verify');
    expect(fresh.journalRef()).toBe('/j');
  });

  it('restore applies only on a cold tracker (same-process guard)', () => {
    const t = activeTracker();
    const snap: WorkflowRunSnapshot = {
      ...t.snapshot(),
      state: 'complete',
    };
    t.restore(snap);
    expect(t.state()).toBe('active');
  });

  it('throws on malformed snapshots', () => {
    const t = new WorkflowRunTracker();
    expect(() => t.restore({ state: 'zombie' } as unknown as WorkflowRunSnapshot)).toThrow();
    expect(() => t.restore({ state: 'active', history: 'bad' } as unknown as WorkflowRunSnapshot)).toThrow();
  });

  it('clear resets everything including history', () => {
    const t = activeTracker();
    t.consumeAgentCall();
    t.transition({ type: 'clear' });
    expect(t.state()).toBe('inactive');
    expect(t.history()).toHaveLength(0);
    expect(t.workflowName()).toBe('');
    expect(t.agentsUsed()).toBe(0);
  });
});
