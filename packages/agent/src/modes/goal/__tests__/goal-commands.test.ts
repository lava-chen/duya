/**
 * Deterministic /goal command handling tests (plan 553).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleGoalCommand, isGoalControlCommand, formatGoalStatus } from '../goal-commands.js';
import { goalModeTracker } from '../goal-tracker.js';

// The vitest child pool owns process.send — real IPC persistence would
// crash it. Persistence itself is covered by the engine tests; these tests
// target the command routing and tracker transitions.
vi.mock('../../engine/persistence.js', () => ({
  persistSnapshot: vi.fn(async () => {}),
  restoreTracker: vi.fn(async () => false),
}));

function startGoalFor(sessionId: string, objective = 'Drive the objective'): void {
  goalModeTracker.transition({ type: 'clear' });
  goalModeTracker.transition({ type: 'start', objective }, sessionId);
}

describe('isGoalControlCommand', () => {
  it('accepts the control verbs and bare /goal', () => {
    expect(isGoalControlCommand('/goal status')).toBe(true);
    expect(isGoalControlCommand('/goal pause')).toBe(true);
    expect(isGoalControlCommand('/goal resume')).toBe(true);
    expect(isGoalControlCommand('/goal clear')).toBe(true);
    expect(isGoalControlCommand('/goal')).toBe(true);
    expect(isGoalControlCommand('/goal help')).toBe(true);
  });

  it('lets objectives and non-goal prompts fall through', () => {
    expect(isGoalControlCommand('/goal ship the release by friday')).toBe(false);
    expect(isGoalControlCommand('/goals')).toBe(false);
    expect(isGoalControlCommand('fix the login bug')).toBe(false);
  });
});

describe('handleGoalCommand', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('status on an idle goal says so', async () => {
    const r = await handleGoalCommand('/goal status', { sessionId: 's1' });
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('No active goal');
  });

  it('pause then resume round-trips with reasons and persistence-safe state', async () => {
    startGoalFor('s1');
    const paused = await handleGoalCommand('/goal pause', { sessionId: 's1' });
    expect(paused.reply).toContain('Goal paused');
    expect(goalModeTracker.state('s1')).toBe('user_paused');
    expect(goalModeTracker.pauseReason('s1')).toBe('user_requested');

    const resumed = await handleGoalCommand('/goal resume', { sessionId: 's1' });
    expect(resumed.reply).toContain('Goal resumed');
    expect(goalModeTracker.state('s1')).toBe('active');
  });

  it('pause works right after a cold start from the persisted fold', async () => {
    // Simulate a restart: snapshot an active goal, wipe the singleton,
    // restore it (folds to user_paused(restart)).
    startGoalFor('s1');
    goalModeTracker.recordWorkerRound('s1');
    const snap = goalModeTracker.snapshot('s1');
    goalModeTracker.transition({ type: 'clear' });
    goalModeTracker.restore(snap);
    expect(goalModeTracker.state('s1')).toBe('user_paused');

    const resumed = await handleGoalCommand('/goal resume', { sessionId: 's1' });
    expect(resumed.reply).toContain('Goal resumed');
    expect(goalModeTracker.state('s1')).toBe('active');
  });

  it('is session-scoped: another session gets the idle replies', async () => {
    startGoalFor('session-owner');
    const r = await handleGoalCommand('/goal status', { sessionId: 's1' });
    expect(r.reply).toContain('No active goal');
  });

  it('clear removes the goal', async () => {
    startGoalFor('s1');
    const r = await handleGoalCommand('/goal clear', { sessionId: 's1' });
    expect(r.reply).toContain('Goal cleared');
    expect(goalModeTracker.state('s1')).toBe('idle');
  });

  it('status renders the banner line with turn counter and reason', async () => {
    startGoalFor('s1', 'Ship the release');
    goalModeTracker.recordWorkerRound('s1');
    goalModeTracker.recordWorkerRound('s1');
    goalModeTracker.transition({ type: 'pause', reason: 'user_requested' }, 's1');
    const text = formatGoalStatus('s1');
    expect(text).toContain('user_paused (user_requested)');
    expect(text).toContain('Turn 2');
    expect(text).toContain('Ship the release');
  });
});
