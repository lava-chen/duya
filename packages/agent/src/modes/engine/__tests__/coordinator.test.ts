/**
 * ModeCoordinator tests (plan 413d).
 *
 * Covers the MVP coordinator body against a real {@link PlanModeTracker}:
 *   - injectTurnReminders: pending → activate + full/reentry reminder;
 *     active → full/sparse alternation; armed exit notice → one-shot exit
 *   - synthetic message shape (role=user, <system-reminder> wrapped, seq_index)
 *   - onRoundEnd: exit_pending → inactive + persist only on transition
 *   - refreshTurn: buffered mid-turn activation flushed exactly once
 *   - filterTools: write tools gated while active, pass-through when idle
 *   - resolveTurnMode: returns trackers due a reminder
 *
 * The db-client module is mocked so the async `persistSnapshot` calls resolve
 * against a fake without a live IPC channel.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModeCoordinator } from '../coordinator.js';
import { ModeTrackerEngine } from '../engine.js';
import { PlanModeTracker } from '../plan-tracker.js';

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

function makeCoordinator(tracker: PlanModeTracker): ModeCoordinator {
  const engine = new ModeTrackerEngine();
  engine.register(tracker);
  return new ModeCoordinator(engine, 'sess-1');
}

/** Push a tracker to `active` via the normal enter → activate path. */
function activate(tracker: PlanModeTracker): void {
  tracker.transition('enter');
  tracker.transition('activate');
}

describe('ModeCoordinator', () => {
  beforeEach(() => {
    mocks.modeStateDb.upsert.mockReset();
    mocks.logger.warn.mockReset();
  });

  it('constructs with an engine and session id, and exposes the engine', () => {
    const coordinator = makeCoordinator(new PlanModeTracker());
    expect(coordinator).toBeInstanceOf(ModeCoordinator);
    expect(coordinator.getEngine()).toBeInstanceOf(ModeTrackerEngine);
  });

  describe('injectTurnReminders', () => {
    it('activates a pending tracker and injects the full reminder', async () => {
      const tracker = new PlanModeTracker();
      tracker.transition('enter'); // inactive → pending
      const coordinator = makeCoordinator(tracker);
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 5);

      expect(tracker.state()).toBe('active');
      expect(messages).toHaveLength(1);
      const msg = messages[0] as { role: string; content: string; seq_index: number };
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('<system-reminder>');
      expect(msg.content).toContain('# Plan Mode Active');
      expect(msg.seq_index).toBe(5);
      // Transition persisted (fire-and-forget inside the sync inject).
      await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
    });

    it('injects the re-entry reminder on plan-mode re-entry', () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      tracker.transition('exit_approved'); // active → inactive
      tracker.transition('enter'); // inactive → pending, wasPreviouslyActive=true
      expect(tracker.isReentry()).toBe(true);

      const messages: unknown[] = [];
      makeCoordinator(tracker).injectTurnReminders(messages, 1);

      expect((messages[0] as { content: string }).content).toContain('Returning to Plan Mode');
    });

    it('alternates full and sparse reminders for an active tracker', () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      const coordinator = makeCoordinator(tracker);

      const first: unknown[] = [];
      coordinator.injectTurnReminders(first, 1); // reminderCount 0 → full
      const second: unknown[] = [];
      coordinator.injectTurnReminders(second, 2); // reminderCount 1 → sparse

      expect((first[0] as { content: string }).content).toContain('# Plan Mode Active');
      expect((second[0] as { content: string }).content).toContain('Plan mode is still active');
    });

    it('injects a one-shot exit reminder and clears the armed flag', () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      tracker.transition('user_exit', { inFlight: true }); // active → exit_pending
      tracker.completeDeferredExit(); // exit_pending → inactive + armed exit
      expect(tracker.hasPendingExitReminder()).toBe(true);

      const coordinator = makeCoordinator(tracker);
      const messages: unknown[] = [];
      coordinator.injectTurnReminders(messages, 1);

      expect((messages[0] as { content: string }).content).toContain('exited Plan Mode');
      expect(tracker.hasPendingExitReminder()).toBe(false);
      // Second inject is a no-op — the exit notice fires exactly once.
      const again: unknown[] = [];
      coordinator.injectTurnReminders(again, 2);
      expect(again).toHaveLength(0);
    });

    it('injects nothing for an idle tracker', () => {
      const tracker = new PlanModeTracker(); // inactive
      const messages: unknown[] = [];
      makeCoordinator(tracker).injectTurnReminders(messages, 1);
      expect(messages).toHaveLength(0);
    });
  });

  describe('onRoundEnd', () => {
    it('completes a deferred exit and persists the transition', async () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      tracker.transition('user_exit', { inFlight: true }); // active → exit_pending
      expect(tracker.state()).toBe('exit_pending');

      const coordinator = makeCoordinator(tracker);
      await coordinator.onRoundEnd();

      expect(tracker.state()).toBe('inactive');
      expect(tracker.hasPendingExitReminder()).toBe(true);
      await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
    });

    it('does not persist when no transition happened', async () => {
      const coordinator = makeCoordinator(new PlanModeTracker()); // inactive
      await coordinator.onRoundEnd();
      expect(mocks.modeStateDb.upsert).not.toHaveBeenCalled();
    });
  });

  describe('refreshTurn', () => {
    it('flushes a buffered mid-turn activation exactly once', () => {
      const tracker = new PlanModeTracker();
      tracker.transition('enter'); // pending
      tracker.transition('activate_mid_turn', { reminderText: 'MID-TURN-REMINDER' });
      expect(tracker.hasPendingActivation()).toBe(true);

      const coordinator = makeCoordinator(tracker);
      const first: unknown[] = [];
      coordinator.refreshTurn(first, 3);

      expect(first).toHaveLength(1);
      expect((first[0] as { content: string }).content).toBe('MID-TURN-REMINDER');
      expect(tracker.hasPendingActivation()).toBe(false);

      // Nothing buffered → second refresh is a no-op.
      const second: unknown[] = [];
      coordinator.refreshTurn(second, 4);
      expect(second).toHaveLength(0);
    });
  });

  describe('filterTools', () => {
    it('removes write/execute tools while a tracker gates, passes through when idle', () => {
      const gated = new PlanModeTracker();
      activate(gated);
      const tools = [
        { name: 'read' },
        { name: 'glob' },
        { name: 'write' },
        { name: 'bash' },
        { name: 'powershell' },
        { name: 'module' },
      ];
      expect(makeCoordinator(gated).filterTools(tools)).toEqual([
        { name: 'read' },
        { name: 'glob' },
      ]);

      const idle = new PlanModeTracker();
      const tools2 = [{ name: 'read' }, { name: 'write' }];
      expect(makeCoordinator(idle).filterTools(tools2)).toEqual(tools2);
    });
  });

  describe('resolveTurnMode', () => {
    it('returns the ids of trackers currently due a reminder', () => {
      const active = new PlanModeTracker();
      activate(active);
      const coordinator = makeCoordinator(active);
      expect(coordinator.resolveTurnMode('user')).toEqual(['plan-task']);

      active.transition('exit_approved');
      expect(coordinator.resolveTurnMode('synthetic')).toEqual([]);
    });
  });
});
