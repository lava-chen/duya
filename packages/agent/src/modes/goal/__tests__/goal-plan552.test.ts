/**
 * Plan 552 goal behaviors — pause reasons, session ownership, reply
 * fingerprint breaker, verification panel timeout, and the builtin
 * goal-continuation / reply-breaker loop hooks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  goalModeTracker,
  GOAL_PAUSE_REASONS,
  type GoalSnapshot,
} from '../goal-tracker.js';
import { verifyGoalCompletion, shouldRunVerificationPanel } from '../goal-evaluator.js';

function freshGoal(objective = 'Ship the thing', sessionId?: string): void {
  goalModeTracker.transition({ type: 'clear' });
  goalModeTracker.transition({ type: 'start', objective }, sessionId);
}

describe('pause reason catalog (plan 552)', () => {
  beforeEach(() => freshGoal());

  it('exposes the closed catalog', () => {
    expect(GOAL_PAUSE_REASONS).toContain('user_requested');
    expect(GOAL_PAUSE_REASONS).toContain('verifier_timeout');
    expect(GOAL_PAUSE_REASONS).toContain('no_progress');
  });

  it('pause carries the structured reason and resume clears it', () => {
    goalModeTracker.transition({ type: 'pause', reason: 'user_requested' });
    expect(goalModeTracker.state()).toBe('user_paused');
    expect(goalModeTracker.pauseReason()).toBe('user_requested');
    goalModeTracker.transition({ type: 'resume' });
    expect(goalModeTracker.state()).toBe('active');
    expect(goalModeTracker.pauseReason()).toBeUndefined();
  });

  it('stall maps to no_progress_paused with the given reason', () => {
    goalModeTracker.transition({ type: 'stall', reason: 'no_progress' });
    expect(goalModeTracker.state()).toBe('no_progress_paused');
    expect(goalModeTracker.pauseReason()).toBe('no_progress');
  });

  it('unknown reasons degrade instead of polluting the catalog', () => {
    goalModeTracker.transition({ type: 'stall', reason: 'not-a-real-reason' });
    expect(goalModeTracker.state()).toBe('no_progress_paused');
    expect(goalModeTracker.pauseReason()).toBe('no_progress_gaps');
  });

  it('a blocked verdict carries its verifier reason', () => {
    goalModeTracker.transition({ type: 'report_completed' });
    goalModeTracker.transition({ type: 'verdict', verdict: 'blocked', reason: 'verifier_timeout' });
    expect(goalModeTracker.state()).toBe('blocked');
    expect(goalModeTracker.pauseReason()).toBe('verifier_timeout');
  });

  it('history rows keep the reason alongside the event', () => {
    goalModeTracker.transition({ type: 'pause', message: 'need input', reason: 'blocked_worker' });
    const last = goalModeTracker.history().at(-1)!;
    expect(last.event).toBe('pause');
    expect(last.reason).toBe('blocked_worker');
  });
});

describe('session ownership (plan 552)', () => {
  it('start binds the owning session; other sessions read idle', () => {
    freshGoal('A goal', 'session-a');
    expect(goalModeTracker.boundSession()).toBe('session-a');
    expect(goalModeTracker.state('session-a')).toBe('active');
    expect(goalModeTracker.state('session-b')).toBe('idle');
    expect(goalModeTracker.objective('session-b')).toBe('');
  });

  it('unbound goals (CLI / legacy) stay visible to every caller', () => {
    freshGoal('Unbound goal');
    expect(goalModeTracker.boundSession()).toBeUndefined();
    expect(goalModeTracker.state('any-session')).toBe('active');
  });

  it('cross-session transitions are rejected', () => {
    freshGoal('A goal', 'session-a');
    expect(goalModeTracker.transition({ type: 'pause' }, 'session-b')).toBe(false);
    expect(goalModeTracker.state('session-a')).toBe('active');
  });

  it('cross-session persistence snapshots are idle, never the owner state', () => {
    freshGoal('A goal', 'session-a');
    goalModeTracker.recordWorkerRound('session-a');
    const bystander = goalModeTracker.snapshot('session-b') as GoalSnapshot;
    expect(bystander.state).toBe('idle');
    expect(bystander.totalWorkerRounds).toBe(0);
    const owner = goalModeTracker.snapshot('session-a') as GoalSnapshot;
    expect(owner.state).toBe('active');
    expect(owner.totalWorkerRounds).toBe(1);
    expect(owner.boundSession).toBe('session-a');
  });
});

describe('reply fingerprint breaker (plan 552)', () => {
  beforeEach(() => freshGoal());

  it('first reply records, second nudges, third pauses', () => {
    expect(goalModeTracker.recordReply('All done, here is the summary.')).toBe('none');
    expect(goalModeTracker.recordReply('All done, here is the summary.')).toBe('nudge');
    expect(goalModeTracker.recordReply('All done, here is the summary.')).toBe('pause');
  });

  it('normalization collapses whitespace before comparing', () => {
    expect(goalModeTracker.recordReply('status:  blocked\non  the same step')).toBe('none');
    expect(goalModeTracker.recordReply('status: blocked\non the same step')).toBe('nudge');
  });

  it('a changed reply resets the streak', () => {
    goalModeTracker.recordReply('same');
    goalModeTracker.recordReply('same');
    expect(goalModeTracker.recordReply('a genuinely different reply')).toBe('none');
    expect(goalModeTracker.recordReply('a genuinely different reply')).toBe('nudge');
  });

  it('empty replies never write a fingerprint nor reset the streak', () => {
    goalModeTracker.recordReply('same');
    expect(goalModeTracker.recordReply('   \n  ')).toBe('none');
    expect(goalModeTracker.recordReply('same')).toBe('nudge');
  });

  it('resume and clear reset the breaker', () => {
    goalModeTracker.recordReply('same');
    goalModeTracker.recordReply('same');
    goalModeTracker.transition({ type: 'stall', reason: 'no_progress' });
    goalModeTracker.transition({ type: 'resume' });
    expect(goalModeTracker.recordReply('same')).toBe('none');
  });
});

describe('restart fold (plan 552)', () => {
  it('restore folds active to user_paused with the restart reason', () => {
    freshGoal('Long goal', 's1');
    goalModeTracker.recordWorkerRound('s1');
    const snap = goalModeTracker.snapshot('s1') as GoalSnapshot;
    goalModeTracker.transition({ type: 'clear' });
    goalModeTracker.restore(snap);
    expect(goalModeTracker.state('s1')).toBe('user_paused');
    expect(goalModeTracker.pauseReason('s1')).toBe('restart');
    // Coordinator auto-resume (auto_resume=true) then revives it.
    goalModeTracker.transition({ type: 'resume' }, 's1');
    expect(goalModeTracker.state('s1')).toBe('active');
    expect(goalModeTracker.pauseReason('s1')).toBeUndefined();
  });
});

describe('verification panel timeout (plan 552)', () => {
  beforeEach(() => freshGoal());

  it('a slow panel settles blocked(verifier_timeout) without tracker side effects', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    // Path relative to THIS file (goal/__tests__/) → src/tool.
    vi.doMock('../../../tool/SubagentTool/runAgent.js', () => ({
      runAgentSync: () =>
        new Promise(() => {
          /* never settles — the timeout must win */
        }),
    }));
    const { verifyGoalCompletion: verifySlow } = await import('../goal-evaluator.js');

    const agentDefinitions = {
      allAgents: [
        {
          agentType: 'verification',
          whenToUse: 'v',
          source: 'built-in',
          getSystemPrompt: () => 'verify',
        },
      ],
    };
    const context = {
      options: {
        sessionId: undefined,
        tools: [],
        workingDirectory: undefined,
        agentDefinitions,
      },
    } as never;

    const result = await verifySlow({
      objective: 'obj',
      finalSummary: 'done',
      context,
      agentDefinitions: agentDefinitions.allAgents,
      verifyTimeoutMs: 30,
      maxTurns: 2,
    });
    expect(result.verdict).toBe('blocked');
    expect(result.pauseReason).toBe('verifier_timeout');
    // No side effects leaked: the stall/gap counters stayed untouched.
    expect(goalModeTracker.classifierRunsAttempted()).toBe(0);
    expect(goalModeTracker.state()).toBe('active');
    vi.restoreAllMocks();
  });

  it('policy matrix picks the right backend', () => {
    expect(shouldRunVerificationPanel('auto', 'ollama')).toBe(false);
    expect(shouldRunVerificationPanel('auto', 'anthropic')).toBe(true);
    expect(shouldRunVerificationPanel('panel', 'ollama')).toBe(true);
    expect(shouldRunVerificationPanel('none', 'anthropic')).toBe(false);
  });
});
