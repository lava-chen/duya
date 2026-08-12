/**
 * ModeCoordinator goal-branch tests (plan 411 Phase 2).
 *
 * Covers the goal tracker's coordinator wiring:
 *   - injectTurnReminders: injects the goal continuation while active
 *     (and nothing while idle)
 *   - onRoundEnd: records worker rounds while active + persists; idle
 *     goals are skipped
 *   - reportGoalTokenUsage: transitions to budget_limited when the goal
 *     budget is exceeded + persists
 *
 * The db-client module is mocked so `persistSnapshot` resolves against a
 * fake without a live IPC channel (same pattern as coordinator.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModeCoordinator } from '../../engine/coordinator.js';
import { ModeTrackerEngine } from '../../engine/engine.js';
import { GoalTracker } from '../goal-tracker.js';
import { PlanModeTracker } from '../../plan/plan-tracker.js';

const mocks = vi.hoisted(() => ({
  modeStateDb: {
    get: vi.fn(),
    upsert: vi.fn(),
    setStatus: vi.fn(),
    listBySession: vi.fn(),
  },
  logger: { warn: vi.fn() },
}));

vi.mock('../../../ipc/db-client.js', () => ({ modeStateDb: mocks.modeStateDb }));
vi.mock('../../../utils/logger.js', () => ({ logger: mocks.logger }));

function makeCoordinator(tracker: GoalTracker): ModeCoordinator {
  const engine = new ModeTrackerEngine();
  engine.register(tracker as never);
  return new ModeCoordinator(engine, 'sess-1');
}

/**
 * Build a coordinator over BOTH the goal and plan trackers (like the real
 * engine) but scoped to only the goal tracker (like DuyaAgent passes the
 * active mode ids). Regression: goal mode must NOT wake plan mode.
 */
function makeScopedCoordinator(
  goalTracker: GoalTracker,
  planTracker: { id: string },
): ModeCoordinator {
  const engine = new ModeTrackerEngine();
  engine.register(goalTracker as never);
  engine.register(planTracker as never);
  return new ModeCoordinator(engine, 'sess-1', new Set(['goal']));
}

/** Start a goal and run it into `active`. */
function startGoal(tracker: GoalTracker, objective = 'Migrate auth'): void {
  tracker.transition({ type: 'start', objective });
}

/** Fresh real PlanModeTracker for the coexistence regression test. */
function makePlanTracker(): PlanModeTracker {
  return new PlanModeTracker();
}

describe('ModeCoordinator — goal branch', () => {
  beforeEach(() => {
    mocks.modeStateDb.upsert.mockReset();
    mocks.logger.warn.mockReset();
  });

  describe('injectTurnReminders', () => {
    it('injects the goal continuation while the goal is active', () => {
      const tracker = new GoalTracker();
      startGoal(tracker);
      const coordinator = makeCoordinator(tracker);
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 3);

      expect(messages).toHaveLength(1);
      const msg = messages[0] as { role: string; content: string; seq_index: number };
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('<system-reminder>');
      expect(msg.content).toContain('Goal NOT complete — continue working');
      expect(msg.content).toContain('Objective: Migrate auth');
      expect(msg.seq_index).toBe(3);
    });

    it('injects nothing while the goal is idle', () => {
      const tracker = new GoalTracker();
      const coordinator = makeCoordinator(tracker);
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 0);
      expect(messages).toHaveLength(0);
    });

    it('does not auto-start an idle goal (needs goal_start / /goal command)', () => {
      const tracker = new GoalTracker();
      const coordinator = makeCoordinator(tracker);
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 0);
      expect(tracker.state()).toBe('idle');
    });

    it('does not wake the plan tracker when only goal mode is active', () => {
      const goal = new GoalTracker();
      startGoal(goal);
      const realPlan = makePlanTracker();
      const coordinator = makeScopedCoordinator(goal, realPlan);
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 0);

      // Goal continuation injected, plan tracker untouched (stays inactive).
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(realPlan.state()).toBe('inactive');
      expect(messages[0]).toMatchObject({ role: 'user' });
    });
  });

  describe('onRoundEnd', () => {
    it('records a worker round and persists while active', async () => {
      const tracker = new GoalTracker();
      startGoal(tracker);
      const coordinator = makeCoordinator(tracker);

      await coordinator.onRoundEnd();

      expect(tracker.totalWorkerRounds()).toBe(1);
      expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1);
      const row = mocks.modeStateDb.upsert.mock.calls[0]![0] as {
        mode: string;
        status: string;
      };
      expect(row.mode).toBe('goal');
      expect(row.status).toBe('active');
    });

    it('skips idle goals (no persist spam)', async () => {
      const tracker = new GoalTracker();
      const coordinator = makeCoordinator(tracker);

      await coordinator.onRoundEnd();

      expect(mocks.modeStateDb.upsert).not.toHaveBeenCalled();
    });

    it('persists terminal states without recording a worker round', async () => {
      const tracker = new GoalTracker();
      startGoal(tracker);
      tracker.transition({ type: 'complete' });
      const coordinator = makeCoordinator(tracker);

      await coordinator.onRoundEnd();

      expect(tracker.totalWorkerRounds()).toBe(0);
      expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool gating stays plan-only (goal must not strip writes)', () => {
    it('filterTools keeps write tools while a goal is active', () => {
      const tracker = new GoalTracker();
      startGoal(tracker); // active
      const coordinator = makeCoordinator(tracker);
      const tools = [{ name: 'read' }, { name: 'edit' }, { name: 'write' }];

      // Goal mode must NOT strip write tools — it is an execution mode.
      expect(coordinator.filterTools(tools as never)).toHaveLength(3);
    });

    it('gateWriteTool returns null (not gated) while a goal is active', () => {
      const tracker = new GoalTracker();
      startGoal(tracker); // active → canGateTools() true
      const coordinator = makeCoordinator(tracker);

      // Plan-file gating must not fire for goal-mode turns.
      expect(
        coordinator.gateWriteTool('write', { file_path: '/x/a.ts' }, '/x'),
      ).toBeNull();
      expect(
        coordinator.gateWriteTool('bash', {}, '/x'),
      ).toBeNull();
    });
  });

  describe('reportGoalTokenUsage', () => {
    it('transitions to budget_limited when the goal budget is exceeded', async () => {
      const tracker = new GoalTracker();
      tracker.transition({ type: 'start', objective: 'X', budget: 1000 });
      const coordinator = makeCoordinator(tracker);

      await coordinator.reportGoalTokenUsage(500);
      expect(tracker.state()).toBe('active');
      expect(mocks.modeStateDb.upsert).not.toHaveBeenCalled();

      await coordinator.reportGoalTokenUsage(1500);
      expect(tracker.state()).toBe('budget_limited');
      expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for goals without a budget', async () => {
      const tracker = new GoalTracker();
      startGoal(tracker, 'X');
      const coordinator = makeCoordinator(tracker);

      await coordinator.reportGoalTokenUsage(10_000_000);
      expect(tracker.state()).toBe('active');
      expect(mocks.modeStateDb.upsert).not.toHaveBeenCalled();
    });
  });
});
