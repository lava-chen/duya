/**
 * Goal continuation reminder tests (plan 411 Phase 2).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoalTracker } from '../goal-tracker.js';
import {
  GOAL_CONTINUATION_SENTINEL,
  renderGoalState,
  renderGoalContinuation,
} from '../goal-reminders.js';
import { renderReminder } from '../../plan/reminders.js';
import { writeGoalPlan } from '../goal-plan.js';

describe('renderGoalState', () => {
  it('renders objective / status / tokens / elapsed', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Migrate auth', budget: 5000 });
    t.updateTokenUsage(1200);

    const block = renderGoalState(t);
    expect(block).toContain('<goal-state>');
    expect(block).toContain('</goal-state>');
    expect(block).toContain('Objective: Migrate auth');
    expect(block).toContain('Status: active');
    expect(block).toContain('Tokens: 1200/5000');
    expect(block).toContain('Elapsed:');
  });

  it('renders raw token count when no budget is set', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.updateTokenUsage(300);
    expect(renderGoalState(t)).toContain('Tokens: 300');
  });
});

describe('renderGoalContinuation', () => {
  it('includes the sentinel, fallback guidance and update_goal note', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'Refactor parser' });

    const text = renderGoalContinuation(t);
    expect(text).toContain(GOAL_CONTINUATION_SENTINEL);
    expect(text).toContain('Continue working toward the objective');
    expect(text).toContain('update_goal');
  });

  it('inlines verifier gaps when present', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.setGaps('tests still red', 'test-red');

    const text = renderGoalContinuation(t);
    expect(text).toContain('Verifier gaps to address');
    expect(text).toContain('tests still red');
  });

  it('mines the next unchecked plan step into the nudge (grok goal_next_step)', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goal-rem-')), 'plan.md');
    writeGoalPlan(planPath, 'Migrate auth');
    t.setPlanFile(planPath);

    const text = renderGoalContinuation(t);
    expect(text).toContain('Next plan step: Migrate auth');
  });

  it('falls back to generic guidance when the plan file is missing', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.setPlanFile('/nonexistent/plan.md');

    const text = renderGoalContinuation(t);
    expect(text).toContain('Continue working toward the objective');
    expect(text).not.toContain('Next plan step:');
  });

  it('wraps cleanly in a system-reminder', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    const wrapped = renderReminder(renderGoalContinuation(t));
    expect(wrapped.startsWith('<system-reminder>')).toBe(true);
    expect(wrapped.endsWith('</system-reminder>')).toBe(true);
  });
});
