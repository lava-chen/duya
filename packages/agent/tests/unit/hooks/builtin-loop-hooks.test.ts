import { describe, expect, it } from 'vitest';
import {
  buildTodoGateInjection,
  createBuiltinLoopHooks,
  PREMATURE_STOP_PRIORITY,
  TODO_GATE_PRIORITY,
  TOOL_INTENT_PRIORITY,
} from '../../../src/hooks/builtin.js';
import type { LoopHookDispatchContext, LoopHookRegistration } from '../../../src/hooks/loop.js';
import type { Task } from '../../../src/session/task-store.js';
import type { Message } from '../../../src/types.js';

function ctx(
  overrides: Partial<Omit<LoopHookDispatchContext, 'event'>> = {},
): Omit<LoopHookDispatchContext, 'event'> {
  return {
    sessionId: 'session-1',
    turnCount: 3,
    seqIndex: 42,
    messages: [],
    ...overrides,
  };
}

function assistantTurn(text: string): Message {
  return { id: `a-${text.length}`, role: 'assistant', content: text, timestamp: 1 };
}

function userTurn(text: string): Message {
  return { id: `u-${text.length}`, role: 'user', content: text, timestamp: 1 };
}

function find(registrations: LoopHookRegistration[], id: string): LoopHookRegistration {
  const reg = registrations.find((r) => r.id === id);
  if (!reg) throw new Error(`registration ${id} not found`);
  return reg;
}

function makeHooks(overrides: Partial<Parameters<typeof createBuiltinLoopHooks>[0]> = {}) {
  return createBuiltinLoopHooks({
    sessionId: 'session-1',
    todoGateEnabled: true,
    antiDeadLoop: { enabled: true, nudgeAt: 8, hardNudgeAt: 12 },
    toolIntentNudgeMax: 2,
    isGoalActive: () => false,
    listTasks: async () => [],
    ...overrides,
  });
}

describe('createBuiltinLoopHooks registration', () => {
  it('registers the four builtin policies with the fixed PreFinalize order', () => {
    const hooks = makeHooks();
    expect(find(hooks, 'builtin.premature-stop').priority).toBe(PREMATURE_STOP_PRIORITY);
    expect(find(hooks, 'builtin.tool-intent').priority).toBe(TOOL_INTENT_PRIORITY);
    expect(find(hooks, 'builtin.todo-gate').priority).toBe(TODO_GATE_PRIORITY);
    expect(find(hooks, 'builtin.dead-loop-nudge')).toBeTruthy();
  });

  it('omits the todo-gate hook when disabled', () => {
    const hooks = makeHooks({ todoGateEnabled: false });
    expect(hooks.some((r) => r.id === 'builtin.todo-gate')).toBe(false);
  });
});

describe('premature-stop hook', () => {
  const hook = () => find(makeHooks({ isGoalActive: () => true }), 'builtin.premature-stop');

  it('vetoes when a goal is active and the closing text matches a bail pattern', async () => {
    const effect = await hook().handler({
      ...ctx({ messages: [assistantTurn("I can't proceed without the credentials.")] }),
      event: 'PreFinalize',
    });
    expect(effect).toMatchObject({ type: 'block_finalize', source: 'premature_stop' });
  });

  it('allows when no goal is active', async () => {
    const effect = await find(makeHooks({ isGoalActive: () => false }), 'builtin.premature-stop').handler({
      ...ctx({ messages: [assistantTurn("I can't proceed.")] }),
      event: 'PreFinalize',
    });
    expect(effect).toBeUndefined();
  });

  it('allows when the closing text has no bail signal', async () => {
    const effect = await hook().handler({
      ...ctx({ messages: [assistantTurn('The fix is complete and verified.')] }),
      event: 'PreFinalize',
    });
    expect(effect).toBeUndefined();
  });
});

describe('tool-intent hook', () => {
  const hook = () => find(makeHooks(), 'builtin.tool-intent');

  it('vetoes when the model announced an action but emitted no tool_use', async () => {
    const effect = await hook().handler({
      ...ctx({ messages: [assistantTurn('Let me read the config file next.')] }),
      event: 'PreFinalize',
      stopReason: 'end_turn',
    });
    expect(effect).toMatchObject({ type: 'block_finalize', source: 'tool_intent' });
  });

  it('allows when the stop reason is not a natural conclusion', async () => {
    const effect = await hook().handler({
      ...ctx({ messages: [assistantTurn('Let me read the config file next.')] }),
      event: 'PreFinalize',
      stopReason: 'max_tokens',
    });
    expect(effect).toBeUndefined();
  });

  it('caps nudges per run', async () => {
    const registration = hook();
    const messages = [assistantTurn('Let me run the tests again.')];
    const first = await registration.handler({ ...ctx({ messages }), event: 'PreFinalize', stopReason: 'end_turn' });
    const second = await registration.handler({ ...ctx({ messages }), event: 'PreFinalize', stopReason: 'end_turn' });
    const third = await registration.handler({ ...ctx({ messages }), event: 'PreFinalize', stopReason: 'end_turn' });
    expect(first).toMatchObject({ type: 'block_finalize' });
    expect(second).toMatchObject({ type: 'block_finalize' });
    expect(third).toBeUndefined(); // nudgeMax = 2
  });
});

describe('todo-gate hook', () => {
  const pending: Task[] = [
    { id: 't1', subject: 'Write tests', status: 'pending' },
    { id: 't2', subject: 'Update docs', status: 'in_progress' },
  ] as Task[];

  const hook = (listTasks: (sessionId: string) => Promise<Task[]>) =>
    find(makeHooks({ listTasks }), 'builtin.todo-gate');

  it('vetoes with task list anchored to the last real user request', async () => {
    const effect = await hook(async () => pending).handler({
      ...ctx({
        messages: [
          userTurn('Ship the release'),
          assistantTurn('Working on it.'),
          userTurn('Also bump the version'), // synthetic turns are absent here; last real wins
        ],
      }),
      event: 'PreFinalize',
      prompt: 'fallback prompt',
    });
    expect(effect).toMatchObject({ type: 'block_finalize', source: 'todo_gate' });
    const injection = (effect as { injection: string }).injection;
    expect(injection).toContain('2 unfinished tasks');
    expect(injection).toContain('- Write tests');
    expect(injection).toContain('- Update docs');
    expect(injection).toContain('Objective: Also bump the version');
  });

  it('falls back to the run prompt when no real user turn exists', async () => {
    const effect = await hook(async () => pending).handler({
      ...ctx({ messages: [assistantTurn('done?')] }),
      event: 'PreFinalize',
      prompt: 'the original request',
    });
    expect((effect as { injection: string }).injection).toContain('Objective: the original request');
  });

  it('fires only once per run even if tasks stay pending', async () => {
    const registration = hook(async () => pending);
    const callCtx = { ...ctx(), event: 'PreFinalize' as const };
    const first = await registration.handler(callCtx);
    const second = await registration.handler(callCtx);
    expect(first).toMatchObject({ type: 'block_finalize' });
    expect(second).toBeUndefined();
  });

  it('fails open when the task store errors', async () => {
    const effect = await hook(async () => {
      throw new Error('db down');
    }).handler({ ...ctx(), event: 'PreFinalize' });
    expect(effect).toBeUndefined();
  });

  it('allows when nothing is pending', async () => {
    const effect = await hook(async () => [{ id: 't1', subject: 'Done thing', status: 'completed' } as Task]).handler({
      ...ctx(),
      event: 'PreFinalize',
    });
    expect(effect).toBeUndefined();
  });

  it('ignores synthetic runtime-context turns when anchoring', async () => {
    const synthetic = userTurn('<system-reminder>internal directive</system-reminder>');
    synthetic.metadata = { runtimeContext: true, source: 'todo_gate' };
    const effect = await hook(async () => pending).handler({
      ...ctx({ messages: [userTurn('Real request'), synthetic] }),
      event: 'PreFinalize',
    });
    expect((effect as { injection: string }).injection).toContain('Objective: Real request');
  });
});

describe('dead-loop nudge hook', () => {
  const hook = () => find(makeHooks(), 'builtin.dead-loop-nudge');

  const statsCtx = (count: number) => ({
    ...ctx(),
    event: 'PostToolUse' as const,
    consecutiveIdenticalToolCalls: { count, toolName: 'Bash', nudgeAt: 8, hardNudgeAt: 12 },
  });

  it('injects the soft nudge at nudgeAt', async () => {
    const effect = await hook().handler(statsCtx(8));
    expect(effect).toMatchObject({ type: 'inject', source: 'dead_loop_nudge' });
    expect((effect as { injection: string }).injection).toContain('8 consecutive identical calls to tool "Bash"');
    expect((effect as { injection: string }).injection).not.toContain('no progress');
  });

  it('injects the hard nudge at hardNudgeAt', async () => {
    const effect = await hook().handler(statsCtx(12));
    expect(effect).toMatchObject({ type: 'inject', source: 'dead_loop_nudge' });
    expect((effect as { injection: string }).injection).toContain('no progress');
  });

  it('stays silent below the thresholds and between them', async () => {
    expect(await hook().handler(statsCtx(3))).toBeUndefined();
    expect(await hook().handler(statsCtx(10))).toBeUndefined();
  });

  it('does nothing without streak stats', async () => {
    expect(await hook().handler({ ...ctx(), event: 'PostToolUse' })).toBeUndefined();
  });
});

describe('buildTodoGateInjection', () => {
  it('uses singular phrasing for a single pending task', () => {
    const text = buildTodoGateInjection([{ subject: 'Only task' }], 'the goal');
    expect(text).toContain('is 1 unfinished task');
    expect(text).toContain('complete it');
  });
});
