/**
 * update_goal tool tests (plan 411 Phase 1).
 *
 * Verifies the sync-ack contract: `completed: true` routes through the
 * GoalTracker into `verifying`, `blocked_reason` pauses the goal, status
 * updates leave the state unchanged, invalid input errors, and the
 * returned JSON carries the tracker's real state (never a self-reported
 * completion).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getGoalTools,
  UPDATE_GOAL_TOOL_NAME,
  GOAL_START_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
} from '../goal-tools.js';
import { goalModeTracker } from '../goal-tracker.js';

function execute(input: Record<string, unknown>) {
  const [, tool] = getGoalTools();
  return tool.executor.execute(input);
}

function executeStart(input: Record<string, unknown>) {
  const [tool] = getGoalTools();
  return tool.executor.execute(input);
}

function resultOf(r: Awaited<ReturnType<typeof execute>>): Record<string, unknown> {
  return JSON.parse(r.result) as Record<string, unknown>;
}

describe('update_goal tool', () => {
  beforeEach(() => {
    // Reset the singleton between tests.
    goalModeTracker.transition({ type: 'clear' });
    goalModeTracker.transition({ type: 'start', objective: 'Fix the pipeline' });
  });

  it('exposes goal_start, update_goal and get_goal tool registrations', () => {
    const tools = getGoalTools();
    expect(tools.map((t) => t.definition.name)).toEqual([
      GOAL_START_TOOL_NAME,
      UPDATE_GOAL_TOOL_NAME,
      GET_GOAL_TOOL_NAME,
    ]);
    expect(tools[1]!.definition.input_schema).toMatchObject({
      type: 'object',
      required: ['completed'],
    });
    expect(tools[0]!.definition.input_schema).toMatchObject({
      type: 'object',
      required: ['objective'],
    });
    expect(tools[2]!.definition.input_schema).toMatchObject({ type: 'object' });
  });

  it('rejects completed=true without a tool-use context (no stranded verifying)', async () => {
    const r = await execute({ completed: true, message: 'done' });
    expect(r.error).toBe(true);
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_verifier_unavailable');
    // The goal must NOT be left in verifying — nothing would resolve it.
    expect(goalModeTracker.state()).not.toBe('verifying');
    expect(goalModeTracker.state()).toBe('active');
  });

  it('completed=true with a context runs the panel and applies the verdict (bugfix: verdict from verifying)', async () => {
    // Mock the verifier to PASS so the full active → verifying → complete
    // cycle is exercised (verdict is only legal from verifying).
    const { vi } = await import('vitest');
    vi.resetModules();
    // Path relative to THIS test file (goal/__tests__/) → src/tool.
    vi.doMock('../../../tool/SubagentTool/runAgent.js', () => ({
      runAgentSync: vi.fn(async () => ({
        id: 'm',
        role: 'assistant',
        content: '{"refuted": false, "evidence": "all tests green"}',
        timestamp: Date.now(),
      })),
    }));
    vi.doMock('../../../process/worker-protocol.js', () => ({
      sendEvent: vi.fn(),
      buildGoalUpdatedEvent: vi.fn(() => ({ type: 'chat:goal_updated', sessionId: 's', state: 'complete', phase: 'idle', objective: 'X', tokensUsed: 0, tokenBudget: 0, consecutiveNotAchieved: 0 })),
    }));
    const { getGoalTools: getTools, UPDATE_GOAL_TOOL_NAME: NAME } = await import('../goal-tools.js');
    const { goalModeTracker: tracker } = await import('../goal-tracker.js');
    tracker.transition({ type: 'clear' });
    tracker.transition({ type: 'start', objective: 'X' });

    const [goalStart] = getTools();
    void goalStart;
    const [, updateTool] = getTools();
    const r = await updateTool.executor.execute(
      { completed: true, message: 'done' },
      undefined,
      {
        options: {
          sessionId: 's',
          tools: [],
          workingDirectory: undefined,
          agentDefinitions: {
            allAgents: [
              {
                agentType: 'verification',
                whenToUse: 'v',
                source: 'built-in',
                getSystemPrompt: () => 'verify',
              },
            ],
          },
        },
      } as never,
    );
    const parsed = JSON.parse(r.result) as Record<string, unknown>;
    expect(parsed.verdict).toBe('achieved');
    expect(parsed.state).toBe('complete');
    expect(tracker.state()).toBe('complete');
  });

  it('blocked_reason pauses the goal with the reason surfaced', async () => {
    const r = await execute({ completed: false, blocked_reason: 'missing API key' });
    const parsed = resultOf(r);
    expect(parsed.state).toBe('user_paused');
    expect(goalModeTracker.state()).toBe('user_paused');
    expect(goalModeTracker.pauseMessage()).toBe('missing API key');
    // Plan 553: model-reported blockers carry the closed-catalog reason.
    expect(goalModeTracker.pauseReason()).toBe('blocked_worker');
  });

  it('status-only updates leave the state unchanged', async () => {
    const r = await execute({ completed: false, message: 'progress note' });
    const parsed = resultOf(r);
    expect(parsed.state).toBe('active');
    expect(goalModeTracker.state()).toBe('active');
  });

  it('errors on invalid input', async () => {
    const r = await execute({});
    expect(r.error).toBe(true);
    expect(String(r.result)).toContain('Invalid input');
  });

  it('rejects completed=true with a stable error code when no goal is active', async () => {
    goalModeTracker.transition({ type: 'clear' });
    const r = await execute({ completed: true });
    expect(r.error).toBe(true);
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_no_goal');
    expect(goalModeTracker.state()).toBe('idle');
  });

  it('rejects updates on a complete goal with a stable error code', async () => {
    goalModeTracker.transition({ type: 'clear' });
    goalModeTracker.transition({ type: 'start', objective: 'X' });
    goalModeTracker.transition({ type: 'complete' });
    const r = await execute({ completed: true });
    expect(r.error).toBe(true);
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_already_complete');
  });

  it('rejects a second completed=true while verification is in flight', async () => {
    goalModeTracker.transition({ type: 'clear' });
    goalModeTracker.transition({ type: 'start', objective: 'X' });
    goalModeTracker.transition({ type: 'report_completed' }); // → verifying
    expect(goalModeTracker.state()).toBe('verifying');

    const r = await execute({ completed: true });
    expect(r.error).toBe(true);
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_in_flight');
    // The goal stays verifying — no second panel run, no state drift.
    expect(goalModeTracker.state()).toBe('verifying');
  });
});

describe('goal_start tool', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('starts a goal from idle with objective and budget', async () => {
    const r = await executeStart({ objective: 'Build the pipeline', budget: 2000 });
    expect(r.error).toBeUndefined();
    const parsed = resultOf(r);
    expect(parsed.started).toBe(true);
    expect(parsed.state).toBe('active');
    expect(goalModeTracker.state()).toBe('active');
    expect(goalModeTracker.objective()).toBe('Build the pipeline');
    expect(goalModeTracker.tokenBudget()).toBe(2000);
  });

  it('refuses to start when a goal is already active', async () => {
    await executeStart({ objective: 'First goal' });
    const r = await executeStart({ objective: 'Second goal' });
    const parsed = resultOf(r);
    expect(parsed.started).toBe(false);
    expect(goalModeTracker.objective()).toBe('First goal');
  });

  it('errors on empty objective', async () => {
    const r = await executeStart({ objective: '' });
    expect(r.error).toBe(true);
    expect(goalModeTracker.state()).toBe('idle');
  });
});

describe('get_goal tool (plan 553)', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  function executeGet() {
    const [, , getTool] = getGoalTools();
    return getTool.executor.execute({});
  }

  it('returns goal: null when no goal is active', async () => {
    const r = await executeGet();
    const parsed = resultOf(r);
    expect(parsed.goal).toBeNull();
  });

  it('returns the full goal payload when a goal is active', async () => {
    goalModeTracker.transition({ type: 'start', objective: 'Ship it', budget: 1000 });
    goalModeTracker.recordWorkerRound();
    goalModeTracker.recordWorkerRound();
    const r = await executeGet();
    const parsed = resultOf(r);
    const goal = parsed.goal as Record<string, unknown>;
    expect(goal.state).toBe('active');
    expect(goal.objective).toBe('Ship it');
    expect(goal.totalWorkerRounds).toBe(2);
    expect(goal.tokenBudget).toBe(1000);
    expect(Array.isArray(goal.history)).toBe(true);
  });
});

describe('goal session ownership (plan 553)', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('update_goal from another session is rejected as no_goal', async () => {
    goalModeTracker.transition({ type: 'start', objective: 'Session A goal' }, 'session-a');
    const [, updateTool] = getGoalTools();
    const r = await updateTool.executor.execute(
      { completed: false, message: 'peeking' },
      undefined,
      { options: { sessionId: 'session-b', tools: [] } } as never,
    );
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_no_goal');
    // The owner still sees the goal untouched.
    expect(goalModeTracker.state('session-a')).toBe('active');
  });

  it('goal_start from another session cannot clobber the owner goal', async () => {
    goalModeTracker.transition({ type: 'start', objective: 'Session A goal' }, 'session-a');
    const [startTool] = getGoalTools();
    const r = await startTool.executor.execute(
      { objective: 'Session B goal' },
      undefined,
      { options: { sessionId: 'session-b', tools: [] } } as never,
    );
    const parsed = resultOf(r);
    expect(parsed.error_code).toBe('goal_update_session_mismatch');
    expect(goalModeTracker.objective('session-a')).toBe('Session A goal');
  });

  it('a bystander session reads idle state and snapshots idle data', () => {
    goalModeTracker.transition({ type: 'start', objective: 'Session A goal' }, 'session-a');
    expect(goalModeTracker.state('session-b')).toBe('idle');
    expect(goalModeTracker.snapshot('session-b').state).toBe('idle');
    expect(goalModeTracker.snapshot('session-a').objective).toBe('Session A goal');
  });

  it('resume from another session is a no-op', async () => {
    goalModeTracker.transition({ type: 'start', objective: 'A' }, 'session-a');
    goalModeTracker.transition({ type: 'pause', reason: 'user_requested' }, 'session-a');
    goalModeTracker.transition({ type: 'resume' }, 'session-b');
    expect(goalModeTracker.state('session-a')).toBe('user_paused');
  });
});

describe('verification policy settle (plan 553)', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('verification policy matrix picks the right backend (decision is pure)', async () => {
    const { shouldRunVerificationPanel } = await import('../goal-evaluator.js');
    expect(shouldRunVerificationPanel('auto', 'ollama')).toBe(false);
    expect(shouldRunVerificationPanel('auto', 'anthropic')).toBe(true);
    expect(shouldRunVerificationPanel('auto', undefined)).toBe(true);
    expect(shouldRunVerificationPanel('panel', 'ollama')).toBe(true);
    expect(shouldRunVerificationPanel('none', 'anthropic')).toBe(false);
  });
});
