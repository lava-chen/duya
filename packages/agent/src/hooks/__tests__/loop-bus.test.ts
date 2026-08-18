/**
 * Loop-hook bus tests (plan 426 Phase 1): priority ordering, failure
 * isolation, first-block-wins veto exclusivity, inject collection, and the
 * single injection channel (applyLoopHookEffect + persistence filter).
 */

import { describe, it, expect, vi } from 'vitest';
import { LoopHookBus, applyLoopHookEffect } from '../loop.js';
import { persistableMessages } from '../../agent/utils/agent-helpers.js';
import type { Message } from '../../types.js';

function makeCtx() {
  return { turnCount: 1, seqIndex: 42, messages: [] as Message[] };
}

describe('LoopHookBus', () => {
  it('dispatches in priority order regardless of registration order', async () => {
    const bus = new LoopHookBus();
    const order: string[] = [];
    bus.register({
      id: 'late',
      events: ['PreTurn'],
      priority: 50,
      handler: () => {
        order.push('late');
      },
    });
    bus.register({
      id: 'early',
      events: ['PreTurn'],
      priority: 10,
      handler: () => {
        order.push('early');
      },
    });
    await bus.dispatch('PreTurn', makeCtx());
    expect(order).toEqual(['early', 'late']);
  });

  it('keeps registration order among equal priorities (default 100)', async () => {
    const bus = new LoopHookBus();
    const order: string[] = [];
    bus.register({
      id: 'a',
      events: ['PreTurn'],
      handler: () => {
        order.push('a');
      },
    });
    bus.register({
      id: 'b',
      events: ['PreTurn'],
      handler: () => {
        order.push('b');
      },
    });
    await bus.dispatch('PreTurn', makeCtx());
    expect(order).toEqual(['a', 'b']);
  });

  it('isolates throwing handlers and still runs later ones (fail-open)', async () => {
    const bus = new LoopHookBus();
    const later = vi.fn(() => ({ type: 'inject' as const, injection: 'ok', source: 'custom' as const }));
    bus.register({
      id: 'throws',
      events: ['PostToolUse'],
      priority: 10,
      handler: () => {
        throw new Error('boom');
      },
    });
    bus.register({ id: 'later', events: ['PostToolUse'], priority: 20, handler: later });

    const effects = await bus.dispatch('PostToolUse', makeCtx());
    expect(later).toHaveBeenCalledTimes(1);
    expect(effects).toEqual([{ type: 'inject', injection: 'ok', source: 'custom' }]);
  });

  it('first block_finalize wins at PreFinalize and short-circuits lower priorities', async () => {
    const bus = new LoopHookBus();
    const lower = vi.fn(() => ({
      type: 'block_finalize' as const,
      injection: 'lower',
      source: 'todo_gate' as const,
    }));
    bus.register({
      id: 'high',
      events: ['PreFinalize'],
      priority: 10,
      handler: () => ({ type: 'block_finalize', injection: 'high', source: 'premature_stop' as const }),
    });
    bus.register({ id: 'low', events: ['PreFinalize'], priority: 30, handler: lower });

    const effects = await bus.dispatch('PreFinalize', makeCtx());
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'block_finalize', source: 'premature_stop' });
    expect(lower).not.toHaveBeenCalled();
  });

  it('collects multiple inject effects in priority order', async () => {
    const bus = new LoopHookBus();
    bus.register({
      id: 'second',
      events: ['PostTurn'],
      priority: 20,
      handler: () => ({ type: 'inject', injection: 'b', source: 'custom' as const }),
    });
    bus.register({
      id: 'first',
      events: ['PostTurn'],
      priority: 10,
      handler: () => ({ type: 'inject', injection: 'a', source: 'custom' as const }),
    });

    const effects = await bus.dispatch('PostTurn', makeCtx());
    expect(effects.map((e) => (e as { injection: string }).injection)).toEqual(['a', 'b']);
  });

  it('ignores effect types invalid for the event', async () => {
    const bus = new LoopHookBus();
    bus.register({
      id: 'bad-veto',
      events: ['PreTurn'],
      handler: () => ({ type: 'block_finalize', injection: 'x', source: 'custom' as const }),
    });
    bus.register({
      id: 'bad-inject',
      events: ['PreFinalize'],
      handler: () => ({ type: 'inject', injection: 'x', source: 'custom' as const }),
    });

    expect(await bus.dispatch('PreTurn', makeCtx())).toEqual([]);
    expect(await bus.dispatch('PreFinalize', makeCtx())).toEqual([]);
  });

  it('only invokes handlers subscribed to the dispatched event', async () => {
    const bus = new LoopHookBus();
    const preTurn = vi.fn();
    const postTurn = vi.fn(() => ({ type: 'inject' as const, injection: 'x', source: 'custom' as const }));
    bus.register({ id: 'pre', events: ['PreTurn'], handler: preTurn });
    bus.register({ id: 'post', events: ['PostTurn'], handler: postTurn });

    const effects = await bus.dispatch('PostTurn', makeCtx());
    expect(preTurn).not.toHaveBeenCalled();
    expect(postTurn).toHaveBeenCalledTimes(1);
    expect(effects).toHaveLength(1);
  });

  it('unregister removes all registrations with the id', async () => {
    const bus = new LoopHookBus();
    bus.register({ id: 'x', events: ['PreTurn'], handler: () => ({ type: 'inject', injection: 'x', source: 'custom' as const }) });
    bus.register({ id: 'x', events: ['PostTurn'], handler: () => ({ type: 'inject', injection: 'x', source: 'custom' as const }) });
    expect(bus.list()).toHaveLength(2);
    bus.unregister('x');
    expect(bus.list()).toHaveLength(0);
    expect(await bus.dispatch('PreTurn', makeCtx())).toEqual([]);
  });
});

describe('applyLoopHookEffect (single injection channel)', () => {
  it('pushes a projected provider user turn wrapped in <system-reminder>', () => {
    const messages: Message[] = [];
    applyLoopHookEffect(messages, { type: 'inject', injection: 'steer now', source: 'tool_intent' }, 7);

    expect(messages).toHaveLength(1);
    const pushed = messages[0];
    expect(pushed.role).toBe('user');
    expect(pushed.content).toBe('<system-reminder>\nsteer now\n</system-reminder>');
    expect((pushed.metadata as Record<string, unknown>).runtimeContext).toBe(true);
    expect((pushed.metadata as Record<string, unknown>).source).toBe('tool_intent');
  });

  it('produces nudges that are never persisted (persistableMessages filter)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ];
    applyLoopHookEffect(messages, { type: 'inject', injection: 'nudge', source: 'dead_loop_nudge' }, 1);
    applyLoopHookEffect(messages, { type: 'block_finalize', injection: 'veto', source: 'premature_stop' }, 1);
    applyLoopHookEffect(messages, { type: 'inject', injection: 'wrap', source: 'max_turns_wrapup' }, 1);

    expect(messages).toHaveLength(5);
    const persisted = persistableMessages(messages);
    expect(persisted.map((m) => m.content)).toEqual(['real question', 'real answer']);
  });
});
