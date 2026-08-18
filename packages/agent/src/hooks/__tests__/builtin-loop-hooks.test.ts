/**
 * Builtin loop-hook tests (plan 426 Phase 2): each steering policy's
 * trigger / no-trigger / disabled / fail-open / latch behavior, plus the
 * fixed PreFinalize priority order (premature-stop → tool-intent → todo-gate).
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinLoopHooks, buildTodoGateInjection } from '../builtin.js';
import { LoopHookBus, type LoopHookRegistration } from '../loop.js';
import type { LoopHookEffect } from '../loop.js';
import type { Task } from '../../session/task-store.js';
import type { Message } from '../../types.js';

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
  nudgeMax?: number;
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
    toolIntentNudgeMax: overrides?.nudgeMax ?? 2,
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
const INTENT_TEXT = 'Let me read the config file and continue.';

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

// ─── tool-intent ───────────────────────────────────────────────────────────

describe('builtin tool-intent hook', () => {
  it('vetoes finalize when intent was announced but no tool_use followed', async () => {
    const f = makeFixture();
    const effects = await finalize(f, { messages: [assistantMsg(INTENT_TEXT)] });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'tool_intent' });
  });

  it('is capped: stops nudging after nudgeMax vetoes', async () => {
    const f = makeFixture({ nudgeMax: 2 });
    const messages = [assistantMsg(INTENT_TEXT)];
    expect((await finalize(f, { messages })).length).toBe(1);
    expect((await finalize(f, { messages })).length).toBe(1);
    expect(await finalize(f, { messages })).toEqual([]);
  });

  it('does not steer on non-natural stop reasons (e.g. max_tokens)', async () => {
    const f = makeFixture();
    expect(await finalize(f, { messages: [assistantMsg(INTENT_TEXT)], stopReason: 'max_tokens' })).toEqual([]);
  });

  it('does not fire on text without a credible intent+action pair', async () => {
    const f = makeFixture();
    expect(await finalize(f, { messages: [assistantMsg('The work is done.')] })).toEqual([]);
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
      expect.arrayContaining(['builtin.premature-stop', 'builtin.tool-intent', 'builtin.dead-loop-nudge']),
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
  it('premature-stop (10) beats tool-intent (20) on the same turn', async () => {
    // Last paragraph starts with the bail line AND carries an intent+action
    // pair, so both hooks have grounds to veto.
    const bothTriggers = "Progress so far is solid.\n\nI can't proceed further. Let me check the config.";
    const f = makeFixture({ isGoalActive: () => true });
    const effects = await finalize(f, { messages: [assistantMsg(bothTriggers)] });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'premature_stop' });
  });

  it('tool-intent (20) beats todo-gate (30) when no goal is active', async () => {
    const f = makeFixture({ isGoalActive: () => false });
    f.listTasks([task('Write tests', 'pending')]);
    const messages = [userMsg('Fix it'), assistantMsg(INTENT_TEXT)];
    const effects = await finalize(f, { messages });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'tool_intent' });
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
