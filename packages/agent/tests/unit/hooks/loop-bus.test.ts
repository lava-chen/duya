import { describe, expect, it, vi } from 'vitest';
import {
  LoopHookBus,
  applyLoopHookEffect,
  type LoopHookDispatchContext,
  type LoopHookEffect,
} from '../../../src/hooks/loop.js';
import type { Message } from '../../../src/types.js';

function baseCtx(overrides: Partial<Omit<LoopHookDispatchContext, 'event'>> = {}): Omit<LoopHookDispatchContext, 'event'> {
  return {
    sessionId: 'session-1',
    turnCount: 1,
    seqIndex: 42,
    messages: [] as Message[],
    ...overrides,
  };
}

const inject = (injection: string): LoopHookEffect => ({
  type: 'inject',
  injection,
  source: 'custom',
});

const block = (injection: string): LoopHookEffect => ({
  type: 'block_finalize',
  injection,
  source: 'custom',
});

describe('LoopHookBus', () => {
  it('collects inject effects from all matching handlers', async () => {
    const bus = new LoopHookBus();
    bus.register({ id: 'a', events: ['PreTurn'], handler: () => inject('one') });
    bus.register({ id: 'b', events: ['PreTurn'], handler: () => inject('two') });
    bus.register({ id: 'c', events: ['PostTurn'], handler: () => inject('never') });

    const effects = await bus.dispatch('PreTurn', baseCtx());
    expect(effects.map((e) => (e as { injection: string }).injection)).toEqual(['one', 'two']);
  });

  it('runs handlers in ascending priority order', async () => {
    const bus = new LoopHookBus();
    const order: string[] = [];
    bus.register({ id: 'late', events: ['PreTurn'], priority: 50, handler: () => { order.push('late'); } });
    bus.register({ id: 'early', events: ['PreTurn'], priority: 10, handler: () => { order.push('early'); } });
    bus.register({ id: 'default', events: ['PreTurn'], handler: () => { order.push('default'); } });

    await bus.dispatch('PreTurn', baseCtx());
    expect(order).toEqual(['early', 'late', 'default']);
  });

  it('short-circuits at the first block_finalize during PreFinalize', async () => {
    const bus = new LoopHookBus();
    const later = vi.fn(() => inject('after'));
    bus.register({ id: 'veto', events: ['PreFinalize'], priority: 10, handler: () => block('stop') });
    bus.register({ id: 'observer', events: ['PreFinalize'], priority: 20, handler: later });

    const effects = await bus.dispatch('PreFinalize', baseCtx());
    expect(effects).toEqual([block('stop')]);
    expect(later).not.toHaveBeenCalled();
  });

  it('isolates throwing handlers and keeps dispatching (fail-open)', async () => {
    const bus = new LoopHookBus();
    const good = vi.fn(() => inject('good'));
    bus.register({
      id: 'broken',
      events: ['PostToolUse'],
      handler: () => {
        throw new Error('boom');
      },
    });
    bus.register({ id: 'good', events: ['PostToolUse'], handler: good });

    const effects = await bus.dispatch('PostToolUse', baseCtx());
    expect(good).toHaveBeenCalled();
    expect(effects).toEqual([inject('good')]);
  });

  it('drops effects that are invalid for the event', async () => {
    const bus = new LoopHookBus();
    // inject is not honored at PreFinalize; block is not honored at PreTurn.
    bus.register({ id: 'wrong-inject', events: ['PreFinalize'], handler: () => inject('nope') });
    bus.register({ id: 'wrong-block', events: ['PreTurn'], handler: () => block('nope') as LoopHookEffect });

    expect(await bus.dispatch('PreFinalize', baseCtx())).toEqual([]);
    expect(await bus.dispatch('PreTurn', baseCtx())).toEqual([]);
  });

  it('unregister removes every registration sharing the id', async () => {
    const bus = new LoopHookBus();
    bus.register({ id: 'x', events: ['PreTurn'], handler: () => inject('a') });
    bus.register({ id: 'x', events: ['PostTurn'], handler: () => inject('b') });
    bus.unregister('x');

    expect(bus.list()).toHaveLength(0);
    expect(await bus.dispatch('PreTurn', baseCtx())).toEqual([]);
    expect(await bus.dispatch('PostTurn', baseCtx())).toEqual([]);
  });
});

describe('applyLoopHookEffect', () => {
  it('pushes a transient system-reminder user turn with source metadata', () => {
    const messages: Message[] = [];
    applyLoopHookEffect(messages, { type: 'inject', injection: 'steer', source: 'dead_loop_nudge' }, 42);

    expect(messages).toHaveLength(1);
    const pushed = messages[0];
    expect(pushed.role).toBe('user');
    expect(String(pushed.content)).toBe('<system-reminder>\nsteer\n</system-reminder>');
    expect(pushed.metadata).toMatchObject({ runtimeContext: true, source: 'dead_loop_nudge' });
 });
});
