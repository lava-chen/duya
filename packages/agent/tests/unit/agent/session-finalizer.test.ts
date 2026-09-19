/**
 * SessionFinalizer unit tests — Plan 550 step 2e (StreamFinalizer).
 *
 * Pin the contracts callers downstream of `streamChat` depend on:
 *
 *   - `finalizeSuccess` runs PreFinalize, PostTurn, mode exit hooks,
 *     SessionEnd, then yields done(reason='completed'); a
 *     `block_finalize` veto short-circuits the natural exit and the
 *     caller receives `false` so it can `continue` the loop.
 *   - `finalizeAbort` refreshes counters and yields Stop,
 *     SessionEnd, done(reason='aborted') in that order.
 *   - `stopReason` is threaded into the PreFinalize context but NOT
 *     the PostTurn context — matches the legacy inline behaviour
 *     (`{...buildHookCtx(), stopReason: turnStopReason}` was only
 *     applied to the PreFinalize call).
 *   - A failing mode exit hook does not block the SessionEnd
 *     dispatch; the finalizer is fail-open at the lifecycle seam.
 *   - The hook dispatcher closure is invoked with the exact event
 *     names the agent-side dispatch uses (`SessionEnd`,
 *     `Stop`), with `reason: 'user_exit'` for SessionEnd and
 *     `reason: 'user_request'` for Stop.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import { SessionFinalizer } from '../../../src/agent/SessionFinalizer.js';
import { LoopHookBus, applyLoopHookEffect, type LoopHookDispatchContext } from '../../../src/hooks/loop.js';
import { runExitHooks } from '../../../src/modes/apply-modes.js';
import type { Message, SSEEvent } from '../../../src/types.js';
import { resolveDeadLoopConfig } from '../../../src/agent/TurnLoopTracker.js';
import { DeadLoopTracker } from '../../../src/agent/TurnLoopTracker.js';
import type { TurnContext } from '../../../src/agent/TurnContext.js';

vi.mock('../../../src/hooks/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/hooks/loop.js')>();
  return {
    ...actual,
    applyLoopHookEffect: vi.fn(actual.applyLoopHookEffect),
  };
});

vi.mock('../../../src/modes/apply-modes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/modes/apply-modes.js')>();
  return {
    ...actual,
    runExitHooks: vi.fn(actual.runExitHooks),
  };
});

function makeContext(): TurnContext {
  return {
    sessionId: 'sess-1',
    workingDirectory: '/tmp/proj',
  } as unknown as TurnContext;
}

function makeBus(): LoopHookBus {
  return new LoopHookBus();
}

function makeDeps(overrides: Partial<{
  messages: Message[];
  loopHooks: LoopHookBus;
  dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'];
  buildHookCtx: () => Omit<LoopHookDispatchContext, 'event'>;
  resolvedModes: unknown;
  modeCtx: unknown;
  stopReason: string | undefined;
  host: { _commitMessages: () => void };
}> = {}): SessionFinalizerDepsForTest {
  const messages: Message[] = overrides.messages ?? [];
  const loopHooks = overrides.loopHooks ?? makeBus();
  const dispatchHooks =
    overrides.dispatchHooks ??
    (async function* (event: string, _input: Record<string, unknown>) {
      // Default: emit nothing; tests override when they care.
      void event;
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
    host: overrides.host ?? { _commitMessages: () => undefined },
    stopReason: overrides.stopReason,
  };
}

type SessionFinalizerDepsForTest = ConstructorParameters<typeof SessionFinalizer>[0];

async function drain<T>(gen: AsyncGenerator<T, unknown, unknown>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('SessionFinalizer.finalizeSuccess (Plan 550 2e)', () => {
  it('yields done(reason=completed) when no hook vetoes', async () => {
    const dispatchCalls: Array<{ event: string; input: Record<string, unknown> }> = [];
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
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
    // SessionEnd must run before done.
    expect(dispatchCalls.map((c) => c.event)).toEqual(['SessionEnd']);
    expect(dispatchCalls[0].input.reason).toBe('user_exit');
  });

  it('returns false and applies the block_finalize effect when PreFinalize vetoes', async () => {
    const messages: Message[] = [
      { id: 'a', role: 'assistant', content: [], timestamp: 1 },
    ];
    const loopHooks = makeBus();
    const injectText = 'prefinalize-veto-system-reminder';
    loopHooks.register({
      id: 'veto-hook',
      events: ['PreFinalize'],
      handler: () => ({
        type: 'block_finalize',
        injection: injectText,
        source: 'custom',
      }),
    });

    const f = new SessionFinalizer(makeDeps({ loopHooks, messages }));

    const events = await drain(f.finalizeSuccess());

    // No SSE events yielded when vetoed.
    expect(events).toEqual([]);
    // applyLoopHookEffect must be called so the loop knows about the
    // injected system-reminder before the next iteration.
    expect(vi.mocked(applyLoopHookEffect)).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({ type: 'block_finalize' }),
      0,
    );
    // The agent-side caller uses the boolean return to `continue`.
    // We can't observe the AsyncGenerator return value here directly;
    // assert via `f.finalizeSuccess().next()` returning
    // `{ value: false, done: true }`.
    const ret = await f.finalizeSuccess().next();
    expect(ret).toEqual({ value: false, done: true });
  });

  it('threads stopReason into PreFinalize but NOT PostTurn', async () => {
    const preFinalizeCtxs: Array<Omit<LoopHookDispatchContext, 'event'>> = [];
    const postTurnCtxs: Array<Omit<LoopHookDispatchContext, 'event'>> = [];
    const loopHooks = makeBus();
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
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
    ) {
      dispatchCalls.push(event);
    };
    const loopHooks = makeBus();
    loopHooks.register({
      id: 'veto',
      events: ['PreFinalize'],
      handler: () => ({
        type: 'block_finalize',
        injection: 'veto',
        source: 'custom',
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
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
    ) {
      order.push(`dispatch:${event}`);
    };
    const resolvedModes = { modes: [{}] } as never;
    const modeCtx = { sessionId: 'sess-1' } as never;

    const f = new SessionFinalizer(
      makeDeps({ dispatchHooks, resolvedModes, modeCtx }),
    );
    await drain(f.finalizeSuccess());

    expect(order).toEqual(['runExitHooks', 'dispatch:SessionEnd']);
  });

  it('continues past a throwing runExitHooks (fail-open)', async () => {
    vi.mocked(runExitHooks).mockImplementationOnce(async () => {
      throw new Error('mode exit hook crashed');
    });
    const dispatchCalls: string[] = [];
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
    ) {
      dispatchCalls.push(event);
    };
    const resolvedModes = { modes: [{}] } as never;
    const modeCtx = { sessionId: 'sess-1' } as never;

    const f = new SessionFinalizer(
      makeDeps({ dispatchHooks, resolvedModes, modeCtx }),
    );
    const events = await drain(f.finalizeSuccess());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'done', reason: 'completed' });
    expect(dispatchCalls).toEqual(['SessionEnd']);
  });
});

describe('SessionFinalizer.finalizeAbort (Plan 550 2e)', () => {
  it('yields done(reason=aborted) and dispatches Stop + SessionEnd in order', async () => {
    const dispatchCalls: Array<{ event: string; input: Record<string, unknown> }> = [];
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
      input,
    ) {
      dispatchCalls.push({ event, input });
    };
    const host = { _commitMessages: vi.fn() };

    const f = new SessionFinalizer(makeDeps({ dispatchHooks, host }));
    const events = await drain(f.finalizeAbort());

    expect(host._commitMessages).toHaveBeenCalledOnce();
    // dispatchHooks yields nothing in this test, so only the done
    // event is yielded; but the order of dispatchHooks calls must
    // be Stop, SessionEnd, and the done event last.
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
    expect(dispatchCalls.map((c) => c.event)).toEqual(['Stop', 'SessionEnd']);
    expect(dispatchCalls[0].input.reason).toBe('user_request');
    expect(dispatchCalls[1].input.reason).toBe('user_exit');
  });

  it('forwards any agent_progress events the dispatcher yields between Stop and SessionEnd', async () => {
    const dispatchHooks: SessionFinalizerDepsForTest['dispatchHooks'] = async function* (
      event,
    ) {
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