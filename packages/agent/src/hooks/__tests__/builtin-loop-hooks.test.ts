/**
 * Builtin loop-hook tests (plan 426 Phase 2): each steering policy's
 * trigger / no-trigger / disabled / fail-open / latch behavior, plus the
 * fixed PreFinalize priority order (premature-stop → todo-gate).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createBuiltinLoopHooks, buildTodoGateInjection } from '../builtin.js';
import { LoopHookBus, type LoopHookRegistration } from '../loop.js';
import type { LoopHookEffect } from '../loop.js';
import type { Task } from '../../session/task-store.js';
import type { Message } from '../../types.js';
import { goalModeTracker } from '../../modes/goal/goal-tracker.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

function task(subject: string, status: Task['status']): Task {
  return { id: `t-${subject}`, subject, description: '', status, blocks: [], blockedBy: [] };
}

interface HookFixture {
  bus: LoopHookBus;
  registrations: LoopHookRegistration[];
  listTasks: (
    tasks?: Task[],
    opts?: { throws?: boolean },
  ) => (sessionId: string) => Promise<Task[]>;
}

function makeFixture(overrides?: {
  isGoalActive?: () => boolean;
  todoGateEnabled?: boolean;
}): HookFixture {
  let taskResponse: Task[] = [];
  let taskThrows = false;
  const listTasksImpl = (sessionId: string) => {
    void sessionId;
    if (taskThrows) throw new Error('db down');
    return Promise.resolve(taskResponse);
  };
  const registrations = createBuiltinLoopHooks({
    sessionId: 's1',
    todoGateEnabled: overrides?.todoGateEnabled ?? true,
    antiDeadLoop: { enabled: true, nudgeAt: 3, hardNudgeAt: 6 },
    isGoalActive: overrides?.isGoalActive ?? (() => false),
    listTasks: listTasksImpl,
  });
  const bus = new LoopHookBus();
  for (const registration of registrations) bus.register(registration);
  return {
    bus,
    registrations,
    listTasks: (tasks, opts) => {
      taskResponse = tasks ?? [];
      taskThrows = opts?.throws ?? false;
      return listTasksImpl;
    },
  };
}

interface DispatchOpts {
  messages?: Message[];
  prompt?: string;
  stopReason?: string;
  streak?: { count: number; toolName: string; nudgeAt: number; hardNudgeAt: number };
  sessionId?: string;
}

async function finalize(f: HookFixture, opts: DispatchOpts = {}): Promise<LoopHookEffect[]> {
  return f.bus.dispatch('PreFinalize', {
    sessionId: 'sessionId' in opts ? opts.sessionId : 's1',
    turnCount: 1,
    seqIndex: 1,
    messages: opts.messages ?? [],
    prompt: opts.prompt,
    stopReason: opts.stopReason,
  });
}

async function postToolUse(f: HookFixture, streak?: DispatchOpts['streak']): Promise<LoopHookEffect[]> {
  return f.bus.dispatch('PostToolUse', {
    sessionId: 's1',
    turnCount: 1,
    seqIndex: 1,
    messages: [],
    consecutiveIdenticalToolCalls: streak,
  });
}

// Straight ASCII apostrophe: the bail regex only matches `can't`.
const BAIL_TEXT = "Progress so far is solid.\n\nI can't proceed without the credentials.";

// ─── premature-stop ────────────────────────────────────────────────────────

describe('builtin premature-stop hook', () => {
  it('vetoes finalize when the goal is active and the model bails', async () => {
    const f = makeFixture({ isGoalActive: () => true });
    const effects = await finalize(f, { messages: [assistantMsg(BAIL_TEXT)] });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'premature_stop' });
  });

  it('does not fire when no goal is active', async () => {
    const f = makeFixture({ isGoalActive: () => false });
    expect(await finalize(f, { messages: [assistantMsg(BAIL_TEXT)] })).toEqual([]);
  });

  it('does not fire on normal closing text', async () => {
    const f = makeFixture({ isGoalActive: () => true });
    expect(await finalize(f, { messages: [assistantMsg('The fix is complete and verified.')] })).toEqual([]);
  });
});

// ─── todo-gate ─────────────────────────────────────────────────────────────

describe('builtin todo-gate hook', () => {
  it('vetoes finalize once when pending/in-progress tasks remain', async () => {
    const f = makeFixture();
    f.listTasks([task('Write tests', 'pending'), task('Ship it', 'completed')]);
    const messages = [userMsg('Fix the login bug'), assistantMsg('I am done with the first step.')];
    const effects = await finalize(f, { messages, prompt: 'Fix the login bug' });
    expect(effects).toHaveLength(1);
    const effect = effects[0] as { type: string; source: string; injection: string };
    expect(effect).toMatchObject({ type: 'block_finalize', source: 'todo_gate' });
    // Anchored to the user's last real query; completed tasks are excluded.
    expect(effect.injection).toContain('Fix the login bug');
    expect(effect.injection).toContain('- Write tests');
    expect(effect.injection).not.toContain('Ship it');
  });

  it('latches: only triggers once per run', async () => {
    const f = makeFixture();
    f.listTasks([task('Write tests', 'pending')]);
    const messages = [userMsg('Fix it'), assistantMsg('Step one done.')];
    expect((await finalize(f, { messages })).length).toBe(1);
    expect(await finalize(f, { messages })).toEqual([]);
  });

  it('does not fire when all tasks are completed', async () => {
    const f = makeFixture();
    f.listTasks([task('Write tests', 'completed')]);
    expect(await finalize(f, { messages: [assistantMsg('All done.')] })).toEqual([]);
  });

  it('fails open when the task store throws', async () => {
    const f = makeFixture();
    f.listTasks([], { throws: true });
    await expect(finalize(f, { messages: [assistantMsg('Done.')] })).resolves.toEqual([]);
  });

  it('does not fire without a session id', async () => {
    const f = makeFixture();
    f.listTasks([task('Write tests', 'pending')]);
    expect(await finalize(f, { messages: [assistantMsg('Done.')], sessionId: undefined })).toEqual([]);
  });

  it('is not registered when todoGateEnabled is false', () => {
    const f = makeFixture({ todoGateEnabled: false });
    expect(f.registrations.map((r) => r.id)).not.toContain('builtin.todo-gate');
    expect(f.registrations.map((r) => r.id)).toEqual(
      expect.arrayContaining(['builtin.premature-stop', 'builtin.dead-loop-nudge']),
    );
  });
});

// ─── dead-loop nudge ───────────────────────────────────────────────────────

describe('builtin dead-loop nudge hook', () => {
  it('injects a soft nudge exactly at nudgeAt', async () => {
    const f = makeFixture();
    const effects = await postToolUse(f, { count: 3, toolName: 'Read', nudgeAt: 3, hardNudgeAt: 6 });
    expect(effects).toHaveLength(1);
    const effect = effects[0] as { type: string; source: string; injection: string };
    expect(effect).toMatchObject({ type: 'inject', source: 'dead_loop_nudge' });
    expect(effect.injection).toContain('3 consecutive identical calls');
  });

  it('injects a hard nudge exactly at hardNudgeAt', async () => {
    const f = makeFixture();
    const effects = await postToolUse(f, { count: 6, toolName: 'Read', nudgeAt: 3, hardNudgeAt: 6 });
    expect(effects).toHaveLength(1);
    const effect = effects[0] as { type: string; source: string; injection: string };
    expect(effect).toMatchObject({ type: 'inject', source: 'dead_loop_nudge' });
    expect(effect.injection).toContain('6 consecutive identical calls');
    expect(effect.injection).toContain('Stop repeating');
  });

  it('stays silent between thresholds and without a streak', async () => {
    const f = makeFixture();
    expect(await postToolUse(f, { count: 4, toolName: 'Read', nudgeAt: 3, hardNudgeAt: 6 })).toEqual([]);
    expect(await postToolUse(f)).toEqual([]);
  });
});

// ─── fixed PreFinalize priority order ─────────────────────────────────────

describe('PreFinalize priority order (first veto wins)', () => {
  it('premature-stop (10) beats todo-gate (30) on the same turn', async () => {
    const f = makeFixture({ isGoalActive: () => true });
    f.listTasks([task('Write tests', 'pending')]);
    const effects = await finalize(f, {
      messages: [userMsg('Fix it'), assistantMsg(BAIL_TEXT)],
      prompt: 'Fix it',
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'premature_stop' });
  });
});

// ─── todo-gate injection builder ───────────────────────────────────────────

describe('buildTodoGateInjection', () => {
  it('renders singular/plural pending task counts', () => {
    expect(buildTodoGateInjection([{ subject: 'only' }], 'req')).toContain('is 1 unfinished task');
    expect(buildTodoGateInjection([{ subject: 'a' }, { subject: 'b' }], 'req')).toContain('are 2 unfinished tasks');
    expect(buildTodoGateInjection([{ subject: 'a' }], 'req')).toContain('Objective: req');
  });
});

describe('disabled loop hooks', () => {
  const make = (disabled?: string[]): LoopHookRegistration[] =>
    createBuiltinLoopHooks({
      sessionId: 's1',
      todoGateEnabled: true,
      antiDeadLoop: { enabled: true, nudgeAt: 3, hardNudgeAt: 6 },
      disabled,
    });

  it('registers all builtin hooks by default (plan 552 adds the goal pair)', () => {
    const ids = make().map((r) => r.id).sort();
    expect(ids).toEqual([
      'builtin.dead-loop-nudge',
      'builtin.goal-continuation',
      'builtin.goal-reply-fingerprint',
      'builtin.premature-stop',
      'builtin.todo-gate',
    ]);
  });

  it('skips ids in the disabled set (an unregistered hook cannot fire)', () => {
    const ids = make(['builtin.todo-gate', 'builtin.premature-stop']).map((r) => r.id);
    expect(ids).not.toContain('builtin.todo-gate');
    expect(ids).not.toContain('builtin.premature-stop');
    expect(ids).toContain('builtin.dead-loop-nudge');
  });

  it('todoGateEnabled still gates todo-gate independently of the disabled set', () => {
    const ids = createBuiltinLoopHooks({
      sessionId: 's1',
      todoGateEnabled: false,
      antiDeadLoop: { enabled: true, nudgeAt: 3, hardNudgeAt: 6 },
    })
      .map((r) => r.id);
    expect(ids).not.toContain('builtin.todo-gate');
  });
});

// ─── goal reply-fingerprint + auto-continuation (plan 552) ─────────────────

const REPLY = 'The work is finished, nothing left to do.';

function startGoalFor(sessionId: string, objective = 'Drive the objective'): void {
  goalModeTracker.transition({ type: 'clear' });
  goalModeTracker.transition({ type: 'start', objective }, sessionId);
}

describe('builtin goal reply-fingerprint hook (plan 552)', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('first identical reply is silent, second nudges, third auto-pauses', async () => {
    startGoalFor('s1');
    const f = makeFixture();
    const messages = [assistantMsg(REPLY)];
    // 1st identical reply: the breaker is silent, but the continuation hook
    // (priority 12, runs after) still vetoes the natural stop.
    const first = await finalize(f, { messages, sessionId: 's1' });
    expect(first[0]).toMatchObject({ source: 'goal_continuation' });
    // 2nd identical reply: the nudge veto (priority 11) short-circuits the bus.
    const nudge = await finalize(f, { messages, sessionId: 's1' });
    expect(nudge).toHaveLength(1);
    expect(nudge[0]).toMatchObject({ type: 'block_finalize', source: 'goal_reply_fingerprint' });
    // 3rd identical reply: the breaker pauses the goal.
    const pause = await finalize(f, { messages, sessionId: 's1' });
    expect(pause).toHaveLength(1);
    expect(pause[0]).toMatchObject({ type: 'block_finalize', source: 'goal_reply_fingerprint' });
    expect(goalModeTracker.state('s1')).toBe('no_progress_paused');
    expect(goalModeTracker.pauseReason('s1')).toBe('no_progress');
    // Paused goal is no longer active — nothing vetoes the next stop.
    expect(await finalize(f, { messages, sessionId: 's1' })).toEqual([]);
  });

  it('stays silent when the goal belongs to another session', async () => {
    startGoalFor('session-owner');
    const f = makeFixture();
    expect(
      await finalize(f, { messages: [assistantMsg(REPLY)], sessionId: 's1' }),
    ).toEqual([]);
    expect(goalModeTracker.state('session-owner')).toBe('active');
  });

  it('a changed reply resets the streak instead of escalating', async () => {
    startGoalFor('s1');
    const f = makeFixture();
    await finalize(f, { messages: [assistantMsg(REPLY)], sessionId: 's1' });
    await finalize(f, { messages: [assistantMsg(REPLY)], sessionId: 's1' });
    // A different reply resets the streak — no fingerprint veto (the
    // continuation hook may still veto on its own, so filter by source).
    const effects = await finalize(f, {
      messages: [assistantMsg('A completely different summary.')],
      sessionId: 's1',
    });
    expect(
      effects.some((e) => (e as { source?: string }).source === 'goal_reply_fingerprint'),
    ).toBe(false);
  });
});

describe('builtin goal continuation hook (plan 552)', () => {
  beforeEach(() => {
    goalModeTracker.transition({ type: 'clear' });
  });

  it('vetoes finalize while the goal is active', async () => {
    startGoalFor('s1');
    const f = makeFixture();
    const effects = await finalize(f, { messages: [assistantMsg('The fix is complete and verified.')], sessionId: 's1' });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'goal_continuation' });
    const effect = effects[0] as { injection: string };
    expect(effect.injection).toContain('Drive the objective');
    expect(effect.injection).toContain('NOT a new user question');
  });

  it('stops vetoing once the goal completes', async () => {
    startGoalFor('s1');
    goalModeTracker.transition({ type: 'complete' }, 's1');
    const f = makeFixture();
    expect(
      await finalize(f, { messages: [assistantMsg('Done.')], sessionId: 's1' }),
    ).toEqual([]);
  });

  it('does not veto another session\'s active goal', async () => {
    startGoalFor('session-owner');
    const f = makeFixture();
    expect(
      await finalize(f, { messages: [assistantMsg('Done.')], sessionId: 's1' }),
    ).toEqual([]);
  });

  it('honors the maxContinues cap per run', async () => {
    startGoalFor('s1');
    const registrations = createBuiltinLoopHooks({
      sessionId: 's1',
      todoGateEnabled: false,
      antiDeadLoop: { enabled: true, nudgeAt: 3, hardNudgeAt: 6 },
      goalContinuation: { enabled: true, maxContinues: 1 },
    });
    const bus = new LoopHookBus();
    for (const registration of registrations) bus.register(registration);
    const dispatch = () =>
      bus.dispatch('PreFinalize', {
        sessionId: 's1',
        turnCount: 1,
        seqIndex: 1,
        messages: [assistantMsg('Progress note.')],
      });
    const first = await dispatch();
    expect(first[0]).toMatchObject({ source: 'goal_continuation' });
    const second = await dispatch();
    expect(second.find((e) => e.type === 'block_finalize' && (e as { source?: string }).source === 'goal_continuation')).toBeUndefined();
  });

  it('is not registered when auto-continuation is disabled', () => {
    const registrations = createBuiltinLoopHooks({
      sessionId: 's1',
      todoGateEnabled: false,
      antiDeadLoop: { enabled: true, nudgeAt: 3, hardNudgeAt: 6 },
      goalContinuation: { enabled: false, maxContinues: 0 },
    });
    expect(registrations.some((r) => r.id === 'builtin.goal-continuation')).toBe(false);
  });
});
