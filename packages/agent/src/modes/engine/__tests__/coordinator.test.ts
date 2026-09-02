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
import { PlanModeTracker } from '../../plan/plan-tracker.js';
import { ResearchTracker } from '../../research-mode/research-tracker.js';
import { resolvePlanFilePath } from '../../plan/plan-file-path.js';
import type { ModeTracker } from '../tracker.js';

const mocks = vi.hoisted(() => ({
  modeStateDb: {
    get: vi.fn(),
    upsert: vi.fn(),
    setStatus: vi.fn(),
    listBySession: vi.fn(),
  },
  logger: { warn: vi.fn(), info: vi.fn() },
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

/** Upcast a concrete ResearchTracker to the engine's existential tracker shape. */
function upcast(tracker: ResearchTracker): ModeTracker<string, string, unknown> {
  return tracker as unknown as ModeTracker<string, string, unknown>;
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
    it('injects the research continuation while a research run is active', () => {
      const research = new ResearchTracker();
      research.transition({ type: 'start', query: 'Compare RAG frameworks' });
      research.transition({ type: 'search' });
      const coordinator = makeCoordinator(upcast(research));
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 7);

      expect(messages).toHaveLength(1);
      const msg = messages[0] as { role: string; content: string; seq_index: number };
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('<system-reminder>');
      expect(msg.content).toContain('<research-state>');
      expect(msg.content).toContain('Query: Compare RAG frameworks');
      expect(msg.seq_index).toBe(7);
    });

    it('injects research continuation marked as runtime_context source=research_continuation', () => {
      const research = new ResearchTracker();
      research.transition({ type: 'start', query: 'Compare RAG frameworks' });
      research.transition({ type: 'search' });
      const coordinator = makeCoordinator(upcast(research));
      const messages: unknown[] = [];

      coordinator.injectTurnReminders(messages, 7);

      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.role).toBe('user');
      expect((msg.metadata as Record<string, unknown>).runtimeContext).toBe(true);
      expect((msg.metadata as Record<string, unknown>).source).toBe('research_continuation');
      expect(msg.seq_index).toBe(7);
    });

    it('does not inject a research reminder on an idle research tracker', () => {
      const research = new ResearchTracker();
      const coordinator = makeCoordinator(upcast(research));
      const messages: unknown[] = [];
      coordinator.injectTurnReminders(messages, 1);
      expect(messages).toHaveLength(0);
    });

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
      // The exit notice fires exactly once; the tracker is still in the active
      // set for this turn, so a later inject re-enters plan mode — and because
      // `wasPreviouslyActive` is still set, it uses the re-entry reminder.
      const again: unknown[] = [];
      coordinator.injectTurnReminders(again, 2);
      expect(again).toHaveLength(1);
      expect((again[0] as { content: string }).content).toContain('Returning to Plan Mode');
      expect(tracker.state()).toBe('active');
    });

    it('enters and activates a fresh inactive tracker, injecting the full reminder', async () => {
      // In production the coordinator is built only when a tracker-bearing mode
      // is active, so an `inactive` tracker means the mode just became active:
      // enter → pending → activate → full reminder, and the transition persists.
      const tracker = new PlanModeTracker();
      const messages: unknown[] = [];
      makeCoordinator(tracker).injectTurnReminders(messages, 1);

      expect(tracker.state()).toBe('active');
      expect(messages).toHaveLength(1);
      expect((messages[0] as { content: string }).content).toContain('# Plan Mode Active');
      await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
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

    it('persists an active research run on round end', async () => {
      const research = new ResearchTracker();
      research.transition({ type: 'start', query: 'X' });
      research.transition({ type: 'search' });
      const coordinator = makeCoordinator(upcast(research));
      await coordinator.onRoundEnd();
      await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
    });

    it('does not persist an idle research run on round end', async () => {
      const research = new ResearchTracker();
      const coordinator = makeCoordinator(upcast(research));
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

    it('gates research web tools by state: readonly blocks web, gathering releases them', () => {
      const tools = [
        { name: 'read' },
        { name: 'web_search' },
        { name: 'web_fetch' },
        { name: 'browser' },
        { name: 'glob' },
      ];

      // clarifying → readonly gate: web tools blocked, read/glob pass.
      const clarifying = new ResearchTracker();
      clarifying.transition({ type: 'start', query: 'X' });
      expect(makeCoordinator(upcast(clarifying)).filterTools(tools)).toEqual([
        { name: 'read' },
        { name: 'glob' },
      ]);

      // gathering → web tools released.
      const gathering = new ResearchTracker();
      gathering.transition({ type: 'start', query: 'X' });
      gathering.transition({ type: 'search' });
      expect(makeCoordinator(upcast(gathering)).filterTools(tools)).toEqual(tools);

      // awaiting_input → waiting gate: web + write frozen, read/glob pass.
      const waiting = new ResearchTracker();
      waiting.transition({ type: 'start', query: 'X' });
      waiting.transition({ type: 'ask_user' });
      expect(makeCoordinator(upcast(waiting)).filterTools(tools)).toEqual([
        { name: 'read' },
        { name: 'glob' },
      ]);
    });
  });

  describe('gateWriteTool', () => {
    it('returns null when no tracker is gating', () => {
      const idle = new PlanModeTracker();
      const coordinator = makeCoordinator(idle);
      expect(coordinator.gateWriteTool('write', { file_path: '/x/y.md' }, '/wd')).toBeNull();
    });

    it('returns null for non-write tools while plan mode is active', () => {
      const gated = new PlanModeTracker();
      activate(gated);
      expect(makeCoordinator(gated).gateWriteTool('read', {}, '/wd')).toBeNull();
      expect(makeCoordinator(gated).gateWriteTool('grep', {}, '/wd')).toBeNull();
    });

    it('allows edit/write only when the target resolves to the plan file', () => {
      const gated = new PlanModeTracker();
      activate(gated);
      const coordinator = makeCoordinator(gated);
      const planFile = resolvePlanFilePath('sess-1');
      // Absolute path to the plan file → allow.
      expect(coordinator.gateWriteTool('edit', { file_path: planFile, old_string: 'a', new_string: 'b' }, '/wd')).toBe('allow');
      expect(coordinator.gateWriteTool('write', { file_path: planFile, content: 'x' }, '/wd')).toBe('allow');
      // A different file → deny.
      expect(coordinator.gateWriteTool('edit', { file_path: '/wd/src/main.ts', old_string: 'a', new_string: 'b' }, '/wd')).toBe('deny');
      expect(coordinator.gateWriteTool('write', { file_path: '/other/plan.md', content: 'x' }, '/wd')).toBe('deny');
    });

    it('denies bash/powershell/module outright while plan mode is active', () => {
      const gated = new PlanModeTracker();
      activate(gated);
      const coordinator = makeCoordinator(gated);
      expect(coordinator.gateWriteTool('bash', { command: 'rm -rf /' }, '/wd')).toBe('deny');
      expect(coordinator.gateWriteTool('powershell', { command: 'x' }, '/wd')).toBe('deny');
      expect(coordinator.gateWriteTool('module', {}, '/wd')).toBe('deny');
    });

    it('denies edit/write with a missing or non-string file_path', () => {
      const gated = new PlanModeTracker();
      activate(gated);
      const coordinator = makeCoordinator(gated);
      expect(coordinator.gateWriteTool('edit', {}, '/wd')).toBe('deny');
      expect(coordinator.gateWriteTool('write', { file_path: 42 }, '/wd')).toBe('deny');
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

  describe('restore', () => {
    it('restores each registered tracker from its persisted snapshot', async () => {
      mocks.modeStateDb.get.mockResolvedValueOnce({
        sessionId: 'sess-1',
        mode: 'plan-task',
        status: 'active',
        reminderCount: 2,
        snapshotJson: JSON.stringify({
          mode: 'plan-task',
          sessionId: 'sess-1',
          status: 'active',
          data: {
            state: 'active',
            wasPreviouslyActive: true,
            reminderCount: 2,
            pendingExitReminder: false,
            awaitingPlanApproval: false,
          },
          updatedAt: 123,
        }),
        updatedAt: 123,
      });
      const tracker = new PlanModeTracker();
      await makeCoordinator(tracker).restore();
      expect(tracker.state()).toBe('active');
      expect(tracker.shouldUseFullReminder()).toBe(true); // reminderCount 2 → full
    });

    it('leaves the tracker initial when no snapshot exists', async () => {
      mocks.modeStateDb.get.mockResolvedValueOnce(null);
      const tracker = new PlanModeTracker();
      await makeCoordinator(tracker).restore();
      expect(tracker.state()).toBe('inactive');
    });
  });

  // Plan 426 Phase 3 — the coordinator re-based onto the loop-hook bus.
  describe('createLoopHookRegistrations (plan 426 Phase 3)', () => {
    function makeCtx(messages: unknown[]) {
      return {
        event: 'PreTurn' as const,
        turnCount: 1,
        seqIndex: 9,
        messages: messages as never,
      };
    }

    it('returns PreTurn and PreFinalize bridge registrations with early priority', () => {
      const registrations = makeCoordinator(new PlanModeTracker()).createLoopHookRegistrations();
      expect(registrations.map((r) => r.id)).toEqual([
        'mode-coordinator.turn-reminders',
        'mode-coordinator.round-end',
      ]);
      expect(registrations[0].events).toEqual(['PreTurn']);
      expect(registrations[0].priority).toBe(5);
      expect(registrations[1].events).toEqual(['PreFinalize']);
      expect(registrations[1].priority).toBe(5);
    });

    it('PreTurn hook injects plan reminders through the runtime-context channel', async () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      const coordinator = makeCoordinator(tracker);
      const [preTurn] = coordinator.createLoopHookRegistrations();

      const messages: unknown[] = [];
      await preTurn.handler(makeCtx(messages));

      // Sparse reminder path: active tracker gets its per-turn reminder.
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('<system-reminder>');
      expect(msg.seq_index).toBe(9);
      // Plan 426 Phase 3 fix: the reminder is stamped as runtime context so
      // lastRealUserQuery never mistakes it for a real user turn.
      expect((msg.metadata as Record<string, unknown>).runtimeContext).toBe(true);
      expect((msg.metadata as Record<string, unknown>).source).toBe('mode');
    });

    it('PreFinalize hook runs round-end transitions (plan deferred exit)', async () => {
      const tracker = new PlanModeTracker();
      activate(tracker);
      tracker.transition('user_exit', { inFlight: true }); // active → exit_pending
      expect(tracker.state()).toBe('exit_pending');
      const coordinator = makeCoordinator(tracker);
      const [, preFinalize] = coordinator.createLoopHookRegistrations();

      await preFinalize.handler(makeCtx([]));

      expect(tracker.state()).toBe('inactive');
    });
  });
});
