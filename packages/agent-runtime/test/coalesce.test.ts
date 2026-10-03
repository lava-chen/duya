/**
 * T3.4 — coalescing, and the causal barrier.
 *
 * The properties under test, in the order the contract states them:
 *
 *  1. Ephemeral deltas merge only within `runId + messageId + blockIndex +
 *     eventType`. Text never merges into thinking, a block never merges into the
 *     next block, a message never merges into the next message.
 *  2. Both a time window and a byte threshold decide, and both are driven by an
 *     injected virtual clock - no real timer is involved in this file.
 *  3. A causally earlier delta flushes BEFORE a `tool.call_started` or a
 *     terminal, and the flush is in first-seen order.
 *  4. Coalescing happens BEFORE seq assignment, so the live stream stays dense
 *     and no sequence number is ever handed to two frames or taken back from
 *     one. This is the placement claim, and it is asserted against the real
 *     `RunSession` ledger rather than against a mock.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';
import { DeltaBatcher, batchedPublisher, coalesceKeyOf, isCoalescable } from '../src/events/coalesce.js';
import type { CoalesceKey, OfferResult } from '../src/events/coalesce.js';
import { RunEventEmitter, type EventPublisher } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import { virtualBatchClock } from './batch-clock.js';

const RUN = 'run-1';

function batcher(options?: { windowMs?: number; maxBytes?: number }) {
  const clock = virtualBatchClock();
  return {
    clock,
    batcher: new DeltaBatcher({
      runId: RUN,
      thresholds: {
        windowMs: options?.windowMs ?? 50,
        maxBytes: options?.maxBytes ?? 4096,
      },
      clock,
    }),
  };
}

const text = (delta: string, index = 0, messageId = 'm1'): RunEvent =>
  ({ type: 'assistant.text_delta', messageId, index, delta }) as RunEvent;
const thinking = (delta: string, index = 0, messageId = 'm1'): RunEvent =>
  ({ type: 'assistant.thinking_delta', messageId, index, delta }) as RunEvent;

/** Everything the batcher published, in order, as payloads. */
function published(results: readonly OfferResult[]): RunEvent[] {
  return results.flatMap((result) => [...result.emit]);
}

describe('a merge key is run, message, block AND type', () => {
  it('never merges thinking into text even though the two payloads are the same shape', () => {
    const { batcher: b } = batcher({ windowMs: 50, maxBytes: 10_000 });
    b.offer(thinking('reasoning '));
    const out = published([b.offer(text('answer ')), b.flush()]);
    expect(out.map((event) => event.type)).toEqual(['assistant.thinking_delta', 'assistant.text_delta']);
    // Each frame kept its own text. A key without `eventType` would produce one
    // frame reading "reasoning answer".
    expect(out[0]).toMatchObject({ delta: 'reasoning ' });
    expect(out[1]).toMatchObject({ delta: 'answer ' });
  });

  it('never merges across a content block', () => {
    const { batcher: b } = batcher({ windowMs: 50, maxBytes: 10_000 });
    b.offer(text('block zero ', 0));
    const out = published([b.offer(text('block one', 1)), b.flush()]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ index: 0, delta: 'block zero ' });
    expect(out[1]).toMatchObject({ index: 1, delta: 'block one' });
  });

  it('never merges across a message', () => {
    const { batcher: b } = batcher({ windowMs: 50, maxBytes: 10_000 });
    b.offer(text('first ', 0, 'm1'));
    const out = published([b.offer(text('second', 0, 'm2')), b.flush()]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ messageId: 'm1', delta: 'first ' });
    expect(out[1]).toMatchObject({ messageId: 'm2', delta: 'second' });
  });

  it('keeps tool argument deltas in a scope of their own, so they cannot collide with a message', () => {
    const { batcher: b } = batcher({ windowMs: 50, maxBytes: 10_000 });
    b.offer({ type: 'tool.arguments_delta', toolCallId: 'same-id', delta: '{"a":' } as RunEvent);
    const out = published([b.offer(text('not json', 0, 'same-id')), b.flush()]);
    expect(out.map((event) => event.type)).toEqual(['tool.arguments_delta', 'assistant.text_delta']);
    expect(out[1]).toMatchObject({ delta: 'not json' });
  });

  it('derives the same key for two events of one block and a different key for a sibling block', () => {
    const a = coalesceKeyOf(RUN, text('x', 0, 'm1')) as CoalesceKey;
    const b = coalesceKeyOf(RUN, text('y', 1, 'm1')) as CoalesceKey;
    expect(a).not.toEqual(b);
    expect(a.scope).toEqual({ kind: 'message', messageId: 'm1', blockIndex: 0 });
  });

  it('reports which types may merge, and refuses everything else', () => {
    expect(isCoalescable('assistant.text_delta')).toBe(true);
    expect(isCoalescable('assistant.thinking_delta')).toBe(true);
    expect(isCoalescable('tool.arguments_delta')).toBe(true);
    // Durable, volatile and terminal frames are never merged: a durable frame is
    // a transcript fact and a terminal is the end of a run.
    expect(isCoalescable('assistant.text_block')).toBe(false);
    expect(isCoalescable('tool.call_started')).toBe(false);
    expect(isCoalescable('run.completed')).toBe(false);
    expect(coalesceKeyOf(RUN, { type: 'run.completed', status: 'ok' } as RunEvent)).toBeNull();
  });
});

describe('both thresholds decide, and both are driven by the injected clock', () => {
  it('flushes a key when the byte threshold is reached, without any time passing', () => {
    // A window of 10s and a byte bound of 120: the bytes trip first.
    const { batcher: b, clock } = batcher({ windowMs: 10_000, maxBytes: 120 });
    const results = [b.offer(text('a'.repeat(200)))];
    expect(clock.current).toBe(0);
    // One frame already over the bound is published on its own rather than held.
    expect(results[0].emit).toHaveLength(1);
    expect(b.pendingFrames).toBe(0);
  });

  it('flushes the accumulated frame once it reaches the byte bound', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 200 });
    const first = b.offer(text('x'.repeat(60)));
    expect(first.emit).toHaveLength(0);
    // Well under the window, but the merged frame now crosses the byte bound.
    const second = b.offer(text('y'.repeat(200)));
    expect(second.emit).toHaveLength(1);
    expect(second.emit[0]).toMatchObject({ delta: `${'x'.repeat(60)}${'y'.repeat(200)}` });
  });

  it('flushes on the time window with no real timer involved', () => {
    const { batcher: b, clock } = batcher({ windowMs: 50, maxBytes: 1_000_000 });
    const published_ = published([b.offer(text('a'))]);
    expect(published_).toHaveLength(0);
    expect(b.pendingFrames).toBe(1);
    expect(clock.pending()).toBe(1);

    clock.advance(49);
    expect(b.metrics.publishedFrames).toBe(0);

    clock.advance(1);
    expect(b.metrics.publishedFrames).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('accounts for every producer frame under exactly one flush reason', () => {
    const { batcher: b, clock } = batcher({ windowMs: 50, maxBytes: 150 });
    // Key A trips the byte bound; key B is closed by a barrier; key C by the
    // window; key D is published without being held. All four paths, so the
    // identity below is actually exercised rather than trivially satisfied.
    b.offer(text('a'.repeat(60), 0));
    b.offer(text('b'.repeat(120), 0)); // crosses the byte bound
    b.offer(text('pending', 1));
    b.offer({ type: 'tool.call_started', toolCallId: 't', toolName: 'x', arguments: {}, attempt: 1 } as RunEvent);
    b.offer(text('c'.repeat(5), 2));
    clock.advance(100); // the window closes key C
    b.offer(text('d'.repeat(5), 3));

    const metrics = b.metrics;
    const reasons = Object.values(metrics.flushFrames).reduce((sum, n) => sum + n, 0);
    expect(reasons + metrics.pendingFrames + metrics.directPublished).toBe(metrics.observedFrames);
    expect(metrics.flushFrames.bytes).toBeGreaterThan(0);
    expect(metrics.flushFrames.barrier).toBeGreaterThan(0);
    expect(metrics.flushFrames.window).toBeGreaterThan(0);
  });

  it('opens a fresh window rather than letting a busy stream exceed one indefinitely', () => {
    // The timer held back, so the entry is still pending when the offer arrives
    // and the offer itself finds the window expired. That is the path a busy
    // stream takes most often, and it must not merge a delta into a frame the
    // window already gave up on.
    const { batcher: b, clock } = batcher({ windowMs: 50, maxBytes: 1_000_000 });
    clock.holdTimers(true);
    expect(b.offer(text('a')).emit).toHaveLength(0);
    clock.advance(60);
    const second = b.offer(text('b'));
    // The stale frame goes out first; `b` opens a new one that stays pending.
    expect(second.emit).toHaveLength(1);
    expect(second.emit[0]).toMatchObject({ delta: 'a' });
    expect(b.metrics.flushFrames.offer_expired).toBe(1);
    expect(b.pendingFrames).toBe(1);
    clock.holdTimers(false);
    clock.advance(50);
    expect(b.metrics.publishedFrames).toBe(2);
  });

  it('publishes the window flush even with no producer event to trigger it', () => {
    // The window has to work on time, not on the next delta. A batcher that held
    // the frame until the producer came back would make staleness depend on the
    // producer rather than on the clock.
    const { batcher: b, clock } = batcher({ windowMs: 50, maxBytes: 1_000_000 });
    const published_ = published([b.offer(text('idle stream'))]);
    expect(published_).toHaveLength(0);
    clock.advance(50);
    expect(b.metrics.publishedFrames).toBe(1);
    expect(b.pendingFrames).toBe(0);
  });
});

describe('a causal barrier flushes the earlier deltas BEFORE it publishes itself', () => {
  it('emits the deltas before tool.call_started, never after', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    // Two blocks, so two pending keys: the frame count is about ORDER here, not
    // about how many merges happened.
    b.offer(text('let me think ', 0));
    b.offer(text('about it', 1));
    const out = published([
      b.offer({
        type: 'tool.call_started',
        toolCallId: 't1',
        toolName: 'read',
        arguments: {},
        attempt: 1,
      } as RunEvent),
    ]);
    expect(out.map((event) => event.type)).toEqual([
      'assistant.text_delta',
      'assistant.text_delta',
      'tool.call_started',
    ]);
    // And the tool call is LAST, not merely present.
    expect(out[out.length - 1].type).toBe('tool.call_started');
  });

  it('publishes the earlier delta merged, and still before the tool call', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    b.offer(text('let me think '));
    b.offer(text('about it'));
    const out = published([
      b.offer({
        type: 'tool.call_started',
        toolCallId: 't1',
        toolName: 'read',
        arguments: {},
        attempt: 1,
      } as RunEvent),
    ]);
    // Same key, so they merged - and the merge still precedes the barrier.
    expect(out.map((event) => event.type)).toEqual(['assistant.text_delta', 'tool.call_started']);
    expect(out[0]).toMatchObject({ delta: 'let me think about it' });
  });

  it('emits the deltas before a terminal', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    b.offer(text('the answer is '));
    const out = published([b.offer({ type: 'run.completed', status: 'ok' } as RunEvent)]);
    expect(out.map((event) => event.type)).toEqual(['assistant.text_delta', 'run.completed']);
  });

  it('never reorders durable ahead of a delta that came before it', () => {
    // The invariant in its strongest form: for every published sequence, the
    // index of a durable frame is never below the index of a delta that preceded
    // it in production order.
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    const results: OfferResult[] = [];
    results.push(b.offer(text('a')));
    results.push(
      b.offer({ type: 'assistant.usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } as RunEvent),
    );
    results.push(b.offer(text('b')));
    results.push(
      b.offer({ type: 'tool.call_started', toolCallId: 't', toolName: 'x', arguments: {}, attempt: 1 } as RunEvent),
    );
    results.push(b.offer(text('c')));
    results.push(b.flush());
    const out = published(results);
    const durableIndexes = out
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'assistant.usage' || event.type === 'tool.call_started');
    const deltaIndexes = out
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'assistant.text_delta');
    expect(out.map((event) => event.type)).toEqual([
      'assistant.text_delta',
      'assistant.usage',
      'assistant.text_delta',
      'tool.call_started',
      'assistant.text_delta',
    ]);
    expect(durableIndexes).toHaveLength(2);
    expect(deltaIndexes).toHaveLength(3);
    // delta a (index 0) precedes assistant.usage; delta c precedes tool.call_started
    expect(durableIndexes[0].index).toBeGreaterThan(deltaIndexes[0].index);
    expect(durableIndexes[1].index).toBeGreaterThan(deltaIndexes[1].index);
  });

  it('flushes pending keys in the order each key was FIRST seen', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    b.offer(text('first', 0));
    b.offer(text('second', 1));
    b.offer(text('third', 2));
    const out = published([b.flush()]);
    expect(out.map((event) => (event as { index: number }).index)).toEqual([0, 1, 2]);
  });
});

describe('coalescing sits BEFORE seq assignment, and that is observable', () => {
  function realRun() {
    const seen: RunEventEnvelope[] = [];
    const appended: RunEventEnvelope[] = [];
    const persistence: RunPersistence = {
      append: async (envelopes) => {
        appended.push(...envelopes);
      },
      complete: async (_t: RunTerminalState, _m: RunMetrics) => undefined,
    };
    const stream: EventPublisher = { push: (envelope) => seen.push(envelope) };
    const session = new RunSession({
      runId: RUN,
      sessionId: 's1',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence,
      flushEvery: 1,
    });
    return { session, stream, seen, appended, emitter: new RunEventEmitter({ session, stream, runId: RUN }) };
  }

  it('keeps the live stream dense: no seq is burned by a frame that was merged away', () => {
    const { batcher: b, clock } = batcher({ windowMs: 50, maxBytes: 1_000_000 });
    const run = realRun();
    const publisher = batchedPublisher(b, run.emitter);

    for (let i = 0; i < 200; i += 1) {
      publisher.publish(text(`t${i} `));
      clock.advance(1);
    }
    publisher.flush();

    // 200 producer frames, 4 published windows, and the sequence numbers the
    // ledger minted are 1..4 with nothing burned between them.
    expect(run.seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(b.metrics.observedFrames).toBe(200);
    expect(b.metrics.publishedFrames).toBe(4);
    // Text is identical to what was produced, which is the "content identical"
    // requirement and the reason a merge needs no repair instruction.
    expect(run.seen.map((e) => (e.payload as { delta: string }).delta).join('')).toBe(
      Array.from({ length: 200 }, (_, i) => `t${i} `).join(''),
    );
  });

  it('never gives one seq to two frames and never reassigns one', () => {
    const { batcher: b, clock } = batcher({ windowMs: 20, maxBytes: 1_000_000 });
    const run = realRun();
    const publisher = batchedPublisher(b, run.emitter);
    const seqsByDelta: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      publisher.publish(text('x'));
      publisher.publish({ type: 'tool.call_started', toolCallId: `t${i}`, toolName: 'n', arguments: {}, attempt: 1 } as RunEvent);
      clock.advance(5);
    }
    publisher.flush();

    const seqs = run.seen.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[seqs.length - 1]).toBe(seqs.length);
    for (const envelope of run.seen) {
      if (envelope.payload.type === 'assistant.text_delta') seqsByDelta.push(envelope.seq);
    }
    expect(seqsByDelta.every((seq) => seq >= 1)).toBe(true);
  });

  it('leaves durable frames untouched: coalescing never touches what storage saw', async () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    const run = realRun();
    const publisher = batchedPublisher(b, run.emitter);
    b.offer(text('unpublished text'));
    publisher.publish({ type: 'run.started', manifestHash: 'h', protocol: '1.0', runtime: 'test' } as RunEvent);
    // The barrier flushed the delta; the durable frame went to storage with the
    // seq the ledger minted for it, and nothing about it was rewritten.
    await run.session.flush();
    expect(run.appended).toHaveLength(1);
    expect(run.appended[0].payload.type).toBe('run.started');
    expect(run.appended[0].seq).toBe(2);
  });

  it('reports the producer-frame count on the frame that stands for them', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    for (let i = 0; i < 12; i += 1) b.offer(text('a'));
    const result = b.flush();
    expect(result.emit).toHaveLength(1);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].producerFrames).toBe(12);
    expect(result.receipts[0].kind).toBe('coalesced');
    expect(result.receipts[0].bytesSaved).toBeGreaterThan(0);
  });

  it('reports no receipt for a frame that stands for exactly one', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    const result = b.offer(text('only'));
    expect(result.receipts).toHaveLength(0);
    expect(b.flush().receipts).toHaveLength(0);
  });
});

describe('the batcher measures what it saves', () => {
  it('reports frames, bytes and the reduction percentage', () => {
    const { batcher: b, clock } = batcher({ windowMs: 10, maxBytes: 1_000_000 });
    for (let i = 0; i < 100; i += 1) {
      b.offer(text('abcd'));
      clock.advance(1);
    }
    b.flush();
    const metrics = b.metrics;
    expect(metrics.observedFrames).toBe(100);
    expect(metrics.publishedFrames).toBe(10);
    expect(metrics.coalescedFrames).toBe(90);
    expect(metrics.bytesOut).toBeLessThan(metrics.bytesIn);
    expect(b.frameReductionPercent).toBeCloseTo(90, 5);
    expect(metrics.droppedFrames).toBe(0);
  });

  it('reports a run that produced nothing as zero rather than NaN', () => {
    const { batcher: b } = batcher();
    expect(b.frameReductionPercent).toBe(0);
    expect(b.metrics.observedFrames).toBe(0);
  });

  it('records the high-water mark of pending frames and bytes', () => {
    const { batcher: b } = batcher({ windowMs: 10_000, maxBytes: 1_000_000 });
    for (let i = 0; i < 5; i += 1) b.offer(text('a', i));
    expect(b.metrics.highWaterFrames).toBe(5);
    expect(b.metrics.highWaterBytes).toBeGreaterThan(0);
    expect(b.metrics.pendingFrames).toBe(5);
  });
});
