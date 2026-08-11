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
import { getGoalTools, UPDATE_GOAL_TOOL_NAME } from '../goal-tools.js';
import { goalModeTracker } from '../engine/goal-tracker.js';

function execute(input: Record<string, unknown>) {
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

  it('exposes a single update_goal tool registration', () => {
    const [tool] = getGoalTools();
    expect(tool.definition.name).toBe(UPDATE_GOAL_TOOL_NAME);
    expect(tool.definition.input_schema).toMatchObject({
      type: 'object',
      required: ['completed'],
    });
  });

  it('completed=true moves the goal into verifying and reports pending verification', async () => {
    const r = await execute({ completed: true, message: 'done' });
    expect(r.error).toBeUndefined();
    const parsed = resultOf(r);
    expect(parsed.accepted).toBe(true);
    expect(parsed.state).toBe('verifying');
    expect(goalModeTracker.state()).toBe('verifying');
    expect(String(parsed.message)).toContain('independently verify');
    // The model must not believe completion was accepted verbatim.
    expect(String(parsed.note)).toContain('do NOT assume the goal is complete');
  });

  it('blocked_reason pauses the goal with the reason surfaced', async () => {
    const r = await execute({ completed: false, blocked_reason: 'missing API key' });
    const parsed = resultOf(r);
    expect(parsed.state).toBe('user_paused');
    expect(goalModeTracker.state()).toBe('user_paused');
    expect(goalModeTracker.pauseMessage()).toBe('missing API key');
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

  it('completed=true from idle is a no-op (no goal to report)', async () => {
    goalModeTracker.transition({ type: 'clear' });
    const r = await execute({ completed: true });
    const parsed = resultOf(r);
    expect(parsed.state).toBe('idle');
    expect(goalModeTracker.state()).toBe('idle');
  });
});
