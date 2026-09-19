/**
 * SessionFinalizer unit tests — Plan 550 step 2e (StreamFinalizer).
 *
 * Covers all three exit paths the finalizer owns:
 *
 *   - `finalizeSuccess` — PreFinalize veto check, PostTurn dispatch,
 *     mode exit hooks, SessionEnd, yield done(reason='completed').
 *   - `finalizeAbort`   — Stop + SessionEnd + done(reason='aborted').
 *   - `finalizeStreamError` — log, executor.discard, cleanup
 *     incomplete `tool_use`, persist cleaned array, refresh
 *     counters, inject synthetic `tool_result` for unmatched
 *     tool_use on AbortError, wrap non-Abort errors with Plan 462
 *     codes, yield error + done(reason='error').
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import { SessionFinalizer } from '../../../src/agent/SessionFinalizer.js';
import { DeadLoopTracker, resolveDeadLoopConfig } from '../../../src/agent/TurnLoopTracker.js';
import type { TurnContext } from '../../../src/agent/TurnContext.js';
import { LoopHookBus, applyLoopHookEffect } from '../../../src/hooks/loop.js';
import type { LoopHookDispatchContext } from '../../../src/hooks/loop.js';
import { runExitHooks } from '../../../src/modes/apply-modes.js';
import type {
  Message,
  MessageContent,
  SSEEvent,
  ToolUseContent,
} from '../../../src/types.js';

vi.mock('../../../src/hooks/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/hooks/loop.js')>();
  return { ...actual, applyLoopHookEffect: vi.fn(actual.applyLoopHookEffect) };
});

vi.mock('../../../src/modes/apply-modes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/modes/apply-modes.js')>();
  return { ...actual, runExitHooks: vi.fn(actual.runExitHooks) };
});

type FinalizerDepsForTest = ConstructorParameters<typeof SessionFinalizer>[0];

function makeContext(): TurnContext {
  return {
    sessionId: 'sess-1',
    workingDirectory: '/tmp/proj',
  } as unknown as TurnContext;
}

function makeDeps(overrides: {
  messages?: Message[];
  loopHooks?: LoopHookBus;
  dispatchHooks?: FinalizerDepsForTest['dispatchHooks'];
  buildHookCtx?: () => Omit<LoopHookDispatchContext, 'event'>;
  resolvedModes?: unknown;
  modeCtx?: unknown;
  stopReason?: string;
  host?: FinalizerDepsForTest['host'];
  executor?: { discard: () => void };
} = {}): FinalizerDepsForTest {
  const messages = overrides.messages ?? [];
  const loopHooks = overrides.loopHooks ?? new LoopHookBus();
  const dispatchHooks =
    overrides.dispatchHooks ??
    (async function* () {
      // default noop
    });
  const buildHookCtx =
    overrides.buildHookCtx ??
    (() => ({
      sessionId: 'sess-1',
      turnCount: 1,
      seqIndex: 0,
      messages,
      prompt: undefined,
    }));
  return {
    messages,
    turnCount: 1,
    seqIndex: 0,
    turnContext: makeContext(),
    deadLoopTracker: new DeadLoopTracker(resolveDeadLoopConfig(undefined)),
    loopHooks,
    dispatchHooks,
    buildHookCtx,
    resolvedModes: overrides.resolvedModes as never,
    modeCtx: overrides.modeCtx as never,
    host: overrides.host ?? {
      _commitMessages: () => undefined,
      _pushDurable: () => undefined,
      setMessages: () => undefined,
    },
    stopReason: overrides.stopReason,
    executor: overrides.executor,
  };
}

async function drain<T>(gen: AsyncGenerator<T, unknown, unknown>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('SessionFinalizer.finalizeSuccess (Plan 550 2e)', () => {
  it('yields done(reason=completed) when no hook vetoes', async () => {
    const dispatchCalls: Array<{ event: string; input: Record<string, unknown> }> = [];
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
      input,
    ) {
      dispatchCalls.push({ event, input });
    };

    const host = { _commitMessages: vi.fn() };
    const f = new SessionFinalizer(makeDeps({ dispatchHooks, host }));

    const events = await drain(f.finalizeSuccess());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'done', reason: 'completed' });
    expect(host._commitMessages).toHaveBeenCalledOnce();
    expect(dispatchCalls.map((c) => c.event)).toEqual(['SessionEnd']);
    expect(dispatchCalls[0].input.reason).toBe('user_exit');
  });

  it('returns false and applies the block_finalize effect when PreFinalize vetoes', async () => {
    const messages: Message[] = [{ id: 'a', role: 'assistant', content: [], timestamp: 1 }];
    const loopHooks = new LoopHookBus();
    loopHooks.register({
      id: 'veto-hook',
      events: ['PreFinalize'],
      handler: () => ({
        type: 'block_finalize' as const,
        injection: 'prefinalize-veto-system-reminder',
        source: 'custom' as const,
      }),
    });

    const f = new SessionFinalizer(makeDeps({ loopHooks, messages }));
    const events = await drain(f.finalizeSuccess());

    expect(events).toEqual([]);
    expect(vi.mocked(applyLoopHookEffect)).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({ type: 'block_finalize' }),
      0,
    );
    const ret = await f.finalizeSuccess().next();
    expect(ret).toEqual({ value: false, done: true });
  });

  it('threads stopReason into PreFinalize but NOT PostTurn', async () => {
    const preFinalizeCtxs: Array<Omit<LoopHookDispatchContext, 'event'>> = [];
    const postTurnCtxs: Array<Omit<LoopHookDispatchContext, 'event'>> = [];
    const loopHooks = new LoopHookBus();
    loopHooks.register({
      id: 'capture-pre',
      events: ['PreFinalize'],
      handler: (ctx) => {
        preFinalizeCtxs.push(ctx);
        return;
      },
    });
    loopHooks.register({
      id: 'capture-post',
      events: ['PostTurn'],
      handler: (ctx) => {
        postTurnCtxs.push(ctx);
        return;
      },
    });

    const f = new SessionFinalizer(makeDeps({ loopHooks, stopReason: 'end_turn' }));
    await drain(f.finalizeSuccess());

    expect(preFinalizeCtxs[0].stopReason).toBe('end_turn');
    expect(postTurnCtxs[0].stopReason).toBeUndefined();
  });

  it('does not dispatch PostTurn, mode-exit hooks, or SessionEnd when PreFinalize vetoes', async () => {
    const dispatchCalls: string[] = [];
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (event) {
      dispatchCalls.push(event);
    };
    const loopHooks = new LoopHookBus();
    loopHooks.register({
      id: 'veto',
      events: ['PreFinalize'],
      handler: () => ({
        type: 'block_finalize' as const,
        injection: 'veto',
        source: 'custom' as const,
      }),
    });

    const f = new SessionFinalizer(makeDeps({ loopHooks, dispatchHooks }));
    await drain(f.finalizeSuccess());

    expect(dispatchCalls).toEqual([]);
    expect(vi.mocked(runExitHooks)).not.toHaveBeenCalled();
  });

  it('runs mode-exit hooks before SessionEnd when resolvedModes is set', async () => {
    const order: string[] = [];
    vi.mocked(runExitHooks).mockImplementationOnce(async () => {
      order.push('runExitHooks');
    });
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (event) {
      order.push(`dispatch:${event}`);
    };
    const resolvedModes = { modes: [{}] } as never;
    const modeCtx = { sessionId: 'sess-1' } as never;

    const f = new SessionFinalizer(makeDeps({ dispatchHooks, resolvedModes, modeCtx }));
    await drain(f.finalizeSuccess());

    expect(order).toEqual(['runExitHooks', 'dispatch:SessionEnd']);
  });

  it('continues past a throwing runExitHooks (fail-open)', async () => {
    vi.mocked(runExitHooks).mockImplementationOnce(async () => {
      throw new Error('mode exit hook crashed');
    });
    const dispatchCalls: string[] = [];
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (event) {
      dispatchCalls.push(event);
    };
    const resolvedModes = { modes: [{}] } as never;
    const modeCtx = { sessionId: 'sess-1' } as never;

    const f = new SessionFinalizer(makeDeps({ dispatchHooks, resolvedModes, modeCtx }));
    const events = await drain(f.finalizeSuccess());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'done', reason: 'completed' });
    expect(dispatchCalls).toEqual(['SessionEnd']);
  });
});

describe('SessionFinalizer.finalizeAbort (Plan 550 2e)', () => {
  it('yields done(reason=aborted) and dispatches Stop + SessionEnd in order', async () => {
    const dispatchCalls: Array<{ event: string; input: Record<string, unknown> }> = [];
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
      input,
    ) {
      dispatchCalls.push({ event, input });
    };
    const host = { _commitMessages: vi.fn() };

    const f = new SessionFinalizer(makeDeps({ dispatchHooks, host }));
    const events = await drain(f.finalizeAbort());

    expect(host._commitMessages).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
    expect(dispatchCalls.map((c) => c.event)).toEqual(['Stop', 'SessionEnd']);
    expect(dispatchCalls[0].input.reason).toBe('user_request');
    expect(dispatchCalls[1].input.reason).toBe('user_exit');
  });

  it('forwards any agent_progress events the dispatcher yields between Stop and SessionEnd', async () => {
    const dispatchHooks: FinalizerDepsForTest['dispatchHooks'] = async function* (event) {
      if (event === 'Stop') {
        yield {
          type: 'agent_progress',
          data: { type: 'hook_invoked', hookEvent: { event: 'Stop' } },
        } as SSEEvent;
      }
    };
    const f = new SessionFinalizer(makeDeps({ dispatchHooks }));
    const events = await drain(f.finalizeAbort());
    expect(events).toHaveLength(2);
    expect((events[0] as { type: string }).type).toBe('agent_progress');
    expect((events[1] as { type: string }).type).toBe('done');
  });
});

describe('SessionFinalizer.finalizeStreamError (Plan 550 2e)', () => {
  it('discards the executor, cleans up, commits, and yields a Plan 462 error + done(error)', async () => {
    const discard = vi.fn();
    const commit = vi.fn();
    const setMessages = vi.fn();
    const pushDurable = vi.fn();

    const f = new SessionFinalizer(
      makeDeps({
        host: { _commitMessages: commit, _pushDurable: pushDurable, setMessages },
        executor: { discard },
      }),
    );

    const events = await drain(f.finalizeStreamError(new Error('provider returned 500')));

    expect(discard).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(pushDurable).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    const [errEvent, doneEvent] = events;
    expect(errEvent).toMatchObject({ type: 'error', data: expect.any(String) });
    expect(doneEvent).toEqual({ type: 'done', reason: 'error' });
  });

  it('strips transient runtime-context envelopes (mailbox / dead-loop-nudge) before setMessages', async () => {
    // Regression: an earlier draft of `finalizeStreamError` used a local
    // mirror of `persistableMessages` that only filtered by role. The
    // canonical helper drops transient runtime-context envelopes
    // (mailbox, background_notification, custom, todo_gate,
    // auto_continue, dead_loop_nudge, premature_stop, tool_intent) so
    // they never reach the durable timeline. This test pins that the
    // fixup uses the canonical helper.
    const messages: Message[] = [
      { id: 'a-real', role: 'assistant', content: 'real', timestamp: 1 },
      {
        id: 'b-runtime',
        role: 'user',
        content: 'should be dropped',
        timestamp: 2,
        metadata: { runtimeContext: true, source: 'mailbox' },
      } as Message,
      {
        id: 'c-runtime',
        role: 'user',
        content: 'should be dropped',
        timestamp: 3,
        metadata: { runtimeContext: true, source: 'dead_loop_nudge' },
      } as Message,
    ];

    let persisted: Message[] = [];
    const setMessages = vi.fn((msgs: Message[]) => {
      persisted = msgs;
    });

    const f = new SessionFinalizer(
      makeDeps({
        messages,
        host: {
          _commitMessages: () => undefined,
          _pushDurable: () => undefined,
          setMessages,
        },
        executor: { discard: () => undefined },
      }),
    );

    await drain(f.finalizeStreamError(new Error('stream died')));

    expect(persisted.find((m) => m.id === 'a-real')).toBeDefined();
    expect(persisted.find((m) => m.id === 'b-runtime')).toBeUndefined();
    expect(persisted.find((m) => m.id === 'c-runtime')).toBeUndefined();
  });

  it('removes a trailing assistant message with unmatched tool_use blocks before persisting', async () => {
    const toolUseBlock: ToolUseContent = {
      type: 'tool_use',
      id: 'orphan-tool-1',
      name: 'read',
      input: { path: '/tmp/x' },
    };
    const messages: Message[] = [
      { id: 'a1', role: 'user', content: 'hi', timestamp: 1 },
      {
        id: 'a2',
        role: 'assistant',
        content: [toolUseBlock],
        timestamp: 2,
      },
    ];

    const setMessagesCalls: Message[][] = [];
    const setMessages = vi.fn((msgs: Message[]) => {
      setMessagesCalls.push(msgs);
    });

    const f = new SessionFinalizer(
      makeDeps({
        messages,
        host: { _commitMessages: () => undefined, _pushDurable: () => undefined, setMessages },
        executor: { discard: () => undefined },
      }),
    );

    await drain(f.finalizeStreamError(new Error('stream died')));

    const persisted = setMessagesCalls[0];
    expect(persisted.find((m) => m.id === 'a2')).toBeUndefined();
    expect(persisted.find((m) => m.id === 'a1')).toBeDefined();
  });

  it('skips synthetic tool_result injection when the trailing assistant is spliced out by cleanup (parity with legacy behaviour)', async () => {
    // The pre-refactor inline code spliced the trailing assistant
    // before the AbortError branch's synthetic-injection loop could
    // see it, so injection was a no-op for fully-orphan trailing
    // assistants. `finalizeStreamError` preserves that ordering.
    const toolUseBlock: ToolUseContent = {
      type: 'tool_use',
      id: 'orphan-abort-1',
      name: 'read',
      input: { path: '/tmp/x' },
    };
    const messages: Message[] = [
      {
        id: 'a-trailing',
        role: 'assistant',
        content: [toolUseBlock],
        timestamp: 1,
      },
    ];

    const pushDurable = vi.fn();
    const f = new SessionFinalizer(
      makeDeps({
        messages,
        host: {
          _commitMessages: () => undefined,
          _pushDurable: pushDurable,
          setMessages: () => undefined,
        },
        executor: { discard: () => undefined },
      }),
    );

    const events = await drain(
      f.finalizeStreamError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    expect(pushDurable).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
  });

  it('skips synthetic injection when a tool_result already exists for the tool_use', async () => {
    const toolUseBlock: ToolUseContent = {
      type: 'tool_use',
      id: 'paired-1',
      name: 'read',
      input: { path: '/tmp/x' },
    };
    const messages: Message[] = [
      {
        id: 'a-mid',
        role: 'assistant',
        content: [toolUseBlock],
        timestamp: 1,
      },
      {
        id: 't-mid',
        role: 'tool',
        content: 'done',
        tool_call_id: 'paired-1',
        timestamp: 2,
      },
    ];

    const pushDurable = vi.fn();
    const f = new SessionFinalizer(
      makeDeps({
        messages,
        host: {
          _commitMessages: () => undefined,
          _pushDurable: pushDurable,
          setMessages: () => undefined,
        },
        executor: { discard: () => undefined },
      }),
    );

    await drain(
      f.finalizeStreamError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    expect(pushDurable).not.toHaveBeenCalled();
  });
});