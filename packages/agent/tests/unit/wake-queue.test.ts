import { describe, expect, it } from 'vitest';
import {
  createWakeQueue,
  dequeueNextWake,
  enqueueWake,
  enqueueWakeBatch,
  peekNextWake,
  removeWakeWhere,
} from '../../src/wake/queue.js';
import {
  isPreemptingItem,
  sourceCanPreempt,
  type WakeItem,
} from '../../src/wake/types.js';

const T = 1_700_000_000_000;

function item(partial: Partial<WakeItem> & { payload: WakeItem['payload'] }): WakeItem {
  const fallback =
    partial.payload.kind === 'user' && partial.payload.messageId == null
      ? `user:${T}`
      : `id-${Math.random().toString(36).slice(2, 8)}`
  return {
    id: partial.id ?? fallback,
    source: partial.source ?? 'user.message',
    lane: partial.lane ?? 'background',
    agentId: partial.agentId ?? 'agent-a',
    enqueuedAtMs: partial.enqueuedAtMs ?? T,
    ...(partial.turnEpoch == null ? {} : { turnEpoch: partial.turnEpoch }),
    ...(partial.isRedriven == null ? {} : { isRedriven: partial.isRedriven }),
    ...(partial.quietOrigin == null ? {} : { quietOrigin: partial.quietOrigin }),
    payload: partial.payload,
  };
}

function userItem(text = 'hello'): WakeItem {
  return item({
    id: 'u1',
    source: 'user.message',
    lane: 'user',
    payload: { kind: 'user', text, messageId: 'm1' },
  });
}

function dmItem(opts: { priority?: boolean; clientMsgId?: string } = {}): WakeItem {
  return item({
    id: `dm-${opts.clientMsgId ?? 'c1'}`,
    source: 'agent.dm',
    lane: 'agent',
    payload: {
      kind: 'dm',
      clientMsgId: opts.clientMsgId ?? 'c1',
      fromAgentId: 'agent-b',
      text: 'hi',
      ...(opts.priority == null ? {} : { priority: opts.priority }),
    },
  });
}

function backgroundItem(opts: { taskId?: string } = {}): WakeItem {
  return item({
    id: `task-${opts.taskId ?? 't1'}`,
    source: 'task.completion',
    lane: 'background',
    payload: { kind: 'completion', taskId: opts.taskId ?? 't1' },
  });
}

describe('WakeQueue — enqueue / dedupe / merge', () => {
  it('starts empty', () => {
    const q = createWakeQueue();
    expect(q.isEmpty).toBe(true);
    expect(q.size).toBe(0);
    expect(peekNextWake(q)).toBeNull();
  });

  it('enqueues into its lane and reports added', () => {
    const { queue, outcome } = enqueueWake(createWakeQueue(), userItem());
    expect(outcome).toBe('added');
    expect(queue.size).toBe(1);
    expect(queue.pending.user).toHaveLength(1);
  });

  it('merges an item with the same dedupe key (newest wins, single entry)', () => {
    const first = enqueueWake(createWakeQueue(), backgroundItem({ taskId: 't1' }));
    const second = enqueueWake(first.queue, backgroundItem({ taskId: 't1' }));
    expect(second.outcome).toBe('merged');
    expect(second.queue.size).toBe(1);
    expect(second.queue.pending.background).toHaveLength(1);
  });

  it('treats different keys as distinct even in the same lane', () => {
    const a = enqueueWake(createWakeQueue(), backgroundItem({ taskId: 't1' }));
    const b = enqueueWake(a.queue, backgroundItem({ taskId: 't2' }));
    expect(b.queue.size).toBe(2);
  });

  it('batch reports addedCount of fresh items only', () => {
    const first = enqueueWake(createWakeQueue(), backgroundItem({ taskId: 't1' }));
    const { queue, addedCount } = enqueueWakeBatch(first.queue, [
      backgroundItem({ taskId: 't1' }), // merge
      backgroundItem({ taskId: 't2' }), // add
    ]);
    expect(addedCount).toBe(1);
    expect(queue.size).toBe(2);
  });
});

describe('WakeQueue — strict lane priority', () => {
  it('head is user lane before agent/background regardless of arrival order', () => {
    let q = createWakeQueue();
    q = enqueueWake(q, backgroundItem()).queue;
    q = enqueueWake(q, dmItem()).queue;
    q = enqueueWake(q, userItem()).queue;
    expect(peekNextWake(q)?.lane).toBe('user');
  });

  it('head is agent lane when no user wake queued', () => {
    let q = createWakeQueue();
    q = enqueueWake(q, backgroundItem()).queue;
    q = enqueueWake(q, dmItem()).queue;
    expect(peekNextWake(q)?.lane).toBe('agent');
  });

  it('dequeueNextWake pops strictly by lane and empties in order', () => {
    let q = createWakeQueue();
    q = enqueueWake(q, backgroundItem()).queue;
    q = enqueueWake(q, userItem()).queue;
    const first = dequeueNextWake(q)!;
    expect(first.item.lane).toBe('user');
    expect(first.queue.size).toBe(1);
    const second = dequeueNextWake(first.queue)!;
    expect(second.item.lane).toBe('background');
    expect(dequeueNextWake(second.queue)).toBeNull();
  });

  it('is FIFO within the same lane', () => {
    let q = createWakeQueue();
    q = enqueueWake(q, backgroundItem({ taskId: 't1' })).queue;
    q = enqueueWake(q, backgroundItem({ taskId: 't2' })).queue;
    const first = dequeueNextWake(q)!;
    expect((first.item.payload as { taskId: string }).taskId).toBe('t1');
  });
});

describe('WakeQueue — remove / predicates', () => {
  it('removes matching items and returns them', () => {
    let q = createWakeQueue();
    q = enqueueWake(q, backgroundItem({ taskId: 't1' })).queue;
    q = enqueueWake(q, backgroundItem({ taskId: 't2' })).queue;
    const { queue, removed } = removeWakeWhere(q, (w) =>
      w.payload.kind === 'completion' && w.payload.taskId === 't1');
    expect(removed).toHaveLength(1);
    expect(queue.size).toBe(1);
  });

  it('remove on empty queue returns empty result', () => {
    const { queue, removed } = removeWakeWhere(createWakeQueue(), () => true);
    expect(removed).toHaveLength(0);
    expect(queue.isEmpty).toBe(true);
  });
});

describe('wake/types — preemption & source lanes', () => {
  it('user lane always preempts', () => {
    expect(isPreemptingItem(userItem())).toBe(true);
  });

  it('priority DM preempts; non-priority DM does not', () => {
    expect(isPreemptingItem(dmItem({ priority: true }))).toBe(true);
    expect(isPreemptingItem(dmItem({ priority: false }))).toBe(false);
  });

  it('background task never preempts', () => {
    expect(isPreemptingItem(backgroundItem())).toBe(false);
  });

  it('only user.message and agent.dm sources may preempt', () => {
    expect(sourceCanPreempt('user.message')).toBe(true);
    expect(sourceCanPreempt('agent.dm')).toBe(true);
    expect(sourceCanPreempt('task.completion')).toBe(false);
    expect(sourceCanPreempt('automation.fire')).toBe(false);
    expect(sourceCanPreempt('broadcast')).toBe(false);
    expect(sourceCanPreempt('connector.inbound')).toBe(false);
  });
});
