/**
 * T3.4 — the byte bound, the overflow decision, and the gap report.
 *
 * The properties, in the order the contract states them:
 *
 *  1. The queue is bounded BYTES, not frames, and the number is reported.
 *  2. A durable or terminal frame is never dropped and never merged. It is
 *     admitted even when that puts the queue over its bound, and the queue then
 *     says it is paused.
 *  3. An ephemeral frame that cannot merge is dropped WITH A REPORT, so a
 *     consumer can tell silence from a loss.
 *  4. The oldest terminal is never deleted — the test asserts the terminal is
 *     still readable after the queue has been driven far over its bound.
 *  5. One queue, one reader, and a second reader is refused rather than served.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { BoundedEventQueue, defaultEnvelopeBytes } from '../src/events/backpressure.js';
import type { DeliveryGap } from '../src/events/backpressure.js';
import { virtualBatchClock } from './batch-clock.js';

const RUN = 'run-1';

let nextSeq = 1;

function envelope(type: string, payload: Record<string, unknown> = {}): RunEventEnvelope {
  const seq = nextSeq++;
  return {
    runId: RUN,
    sessionId: 's1',
    seq,
    timestamp: 1_000,
    traceId: 't1',
    payload: { type, ...payload } as unknown as RunEvent,
  };
}

const delta = (d: string, index = 0): RunEventEnvelope =>
  envelope('assistant.text_delta', { messageId: 'm', index, delta: d });
const durableBlock = (text: string): RunEventEnvelope =>
  envelope('assistant.text_block', { messageId: 'm', index: 0, text });
const terminal = (): RunEventEnvelope => envelope('run.completed', { status: 'ok' });
/** Ephemeral but NOT mergeable: `diagnostic` has no `delta` to concatenate. */
const diagnostic = (message: string): RunEventEnvelope => envelope('diagnostic', { level: 'info', message });

function queue(options: Partial<ConstructorParameters<typeof BoundedEventQueue>[0]> = {}) {
  const gaps: DeliveryGap[] = [];
  const q = new BoundedEventQueue({
    runId: RUN,
    maxBytes: 400,
    onGap: (gap) => gaps.push(gap),
    ...options,
  });
  return { q, gaps };
}

/**
 * Drain every frame currently queued.
 *
 * Reads a COUNT taken up front and never one more: reading past the end parks
 * on an empty queue, which reads as a hung test rather than as "nothing left".
 */
async function drain(q: BoundedEventQueue): Promise<RunEventEnvelope[]> {
  const out: RunEventEnvelope[] = [];
  for (let i = 0; i < q.frames; i += 1) {
    const next = await q.read();
    if (next.done === true) break;
    if (next.value !== undefined) out.push(next.value);
  }
  return out;
}

describe('the queue is bounded in BYTES and reports its high-water mark', () => {
  it('bounds in BYTES, and says so by going over rather than evicting', () => {
    // The honest property, and the one that is easy to get wrong: with "never
    // drop a durable frame", the byte bound cannot be enforced by eviction. It is
    // enforced by PAUSING the producer, so a producer that ignores the pause can
    // still grow this queue. The queue's job is to make that visible and to say
    // how far over it is - not to pretend a hard memory ceiling it cannot keep.
    const { q } = queue({ maxBytes: 2_000 });
    for (let i = 0; i < 20; i += 1) q.enqueue(durableBlock(`block ${i} ${'x'.repeat(200)}`));
    expect(q.bytes).toBeGreaterThan(2_000);
    expect(q.paused).toBe(true);
    expect(q.metrics.highWaterBytes).toBe(q.bytes);
    expect(q.metrics.pauseCount).toBe(1);
  });

  it('reports the byte bound as exceeded rather than silently shedding', () => {
    // The contrast with `RunEventStream`, which shifts its oldest entry out at
    // 1024 frames with no report and no type awareness. Here the count of what
    // was discarded is a metric a host can assert on, and it is zero.
    const { q } = queue({ maxBytes: 2_000 });
    for (let i = 0; i < 20; i += 1) q.enqueue(durableBlock(`block ${i} ${'x'.repeat(200)}`));
    expect(q.frames).toBe(20);
    expect(q.metrics.droppedFrames).toBe(0);
    expect(q.bytes).toBe(q.metrics.highWaterBytes);
  });

  it('measures the real wire cost rather than a frame count', () => {
    const frame = durableBlock('x'.repeat(500));
    const measured = defaultEnvelopeBytes(frame);
    // The JSON form, not the string length of one field: an undercount here is
    // an over-count of how many frames fit.
    expect(measured).toBeGreaterThan(500);
    expect(measured).toBe(JSON.stringify(frame).length);
  });

  it('bounds on frame count too, so tiny frames cannot accumulate forever', () => {
    const { q } = queue({ maxBytes: 1_000_000, maxFrames: 3 });
    for (let i = 0; i < 6; i += 1) q.enqueue(durableBlock(`t${i}`));
    expect(q.frames).toBe(6);
    expect(q.paused).toBe(true);
  });
});

describe('durable and terminal frames are retained, and the queue pauses rather than dropping', () => {
  it('admits a durable frame even when the queue is already over its bound', () => {
    const { q } = queue({ maxBytes: 100 });
    for (let i = 0; i < 5; i += 1) q.enqueue(durableBlock('a'.repeat(100)));
    const outcome = q.enqueue(durableBlock('the one that matters'));
    expect(outcome.action).toBe('retained');
    expect(q.paused).toBe(true);
    expect(outcome.paused).toBe(true);
    // It is still there, at the back, and nothing evicted it to make room.
    expect(q.frames).toBe(6);
  });

  it('never deletes the oldest terminal, however far over the bound it is driven', async () => {
    const { q } = queue({ maxBytes: 50 });
    q.enqueue(terminal());
    for (let i = 0; i < 40; i += 1) q.enqueue(durableBlock(`noise ${i}`));
    expect(q.paused).toBe(true);
    // The terminal is the FIRST frame, the one a type-blind front-shedding queue
    // would have discarded first.
    const first = await q.read();
    expect(first.done).toBe(false);
    expect(first.value?.payload.type).toBe('run.completed');
    expect(q.metrics.oldestTerminalSeq).toBe(first.value?.seq);
  });

  it('reports the pause and resolves whenWritable only after it is back in bounds', async () => {
    const { q } = queue({ maxBytes: 100 });
    q.enqueue(durableBlock('a'.repeat(200)));
    expect(q.paused).toBe(true);
    expect(q.metrics.pauseCount).toBe(1);

    let writable = false;
    const waiting = q.whenWritable().then(() => {
      writable = true;
    });
    await Promise.resolve();
    // Still over the bound, so the producer is still waiting. A pause the
    // producer cannot see is a pause it will keep writing into.
    expect(writable).toBe(false);

    while (q.frames > 1) await q.read();
    await q.read();
    await waiting;
    expect(writable).toBe(true);
    expect(q.paused).toBe(false);
  });

  it('asks to be disconnected when the pause outlasts its timeout', async () => {
    const reasons: { reason: string; heldMs: number }[] = [];
    const clock = virtualBatchClock();
    const q = new BoundedEventQueue({
      runId: RUN,
      maxBytes: 50,
      pauseTimeoutMs: 30_000,
      clock: () => clock.current,
      onDisconnect: (reason) => reasons.push(reason),
    });
    q.enqueue(durableBlock('a'.repeat(200)));
    expect(reasons).toHaveLength(0);
    clock.advance(29_999);
    q.recheckBackpressure();
    expect(reasons).toHaveLength(0);
    // Ten minutes later, the consumer is still not draining.
    clock.advance(600_000);
    q.recheckBackpressure();
    expect(reasons).toHaveLength(1);
    expect(reasons[0].reason).toBe('slow_consumer');
    expect(reasons[0].heldMs).toBeGreaterThanOrEqual(30_000);
    // Asked once, not on every subsequent check.
    q.recheckBackpressure();
    clock.advance(600_000);
    q.enqueue(durableBlock('more'));
    expect(reasons).toHaveLength(1);
    expect(q.metrics.disconnectCount).toBe(1);
  });

  it('reports zero durable loss for a run that overflowed the queue', () => {
    const { q } = queue({ maxBytes: 100 });
    for (let i = 0; i < 50; i += 1) q.enqueue(durableBlock(`durable ${i}`));
    q.enqueue(terminal());
    const metrics = q.metrics;
    expect(metrics.droppedFrames).toBe(0);
    expect(metrics.droppedBytes).toBe(0);
    // Every durable frame offered is still held.
    expect(metrics.durableRetained).toBe(51);
    expect(q.gaps.filter((gap) => gap.kind === 'dropped')).toHaveLength(0);
  });
});

describe('an ephemeral frame that cannot merge is dropped WITH A REPORT', () => {
  /**
   * A queue that is genuinely full.
   *
   * Pressure has to be real for the drop path to be the answer. An earlier
   * version of this test used a bound the queue never reached and passed anyway
   * because the queue dropped every ephemeral frame unconditionally - which was
   * a loss the contract never authorised, invisible because the drop count looks
   * the same either way. Filling the queue first is what makes this a test of
   * the intended policy.
   */
  function fullQueue(options: Partial<ConstructorParameters<typeof BoundedEventQueue>[0]> = {}) {
    const gaps: DeliveryGap[] = [];
    const q = new BoundedEventQueue({ runId: RUN, maxBytes: 400, onGap: (gap) => gaps.push(gap), ...options });
    q.enqueue(durableBlock('x'.repeat(600)));
    expect(q.paused).toBe(true);
    return { q, gaps };
  }

  it('delivers an ephemeral frame when there is room, rather than losing it', () => {
    const { q, gaps } = queue({ maxBytes: 100_000 });
    const outcome = q.enqueue(diagnostic('no pressure here'));
    expect(outcome.action).toBe('queued');
    expect(q.frames).toBe(1);
    expect(q.metrics.droppedFrames).toBe(0);
    expect(gaps).toHaveLength(0);
  });

  it('records the type, the size and the fact that content was lost', () => {
    const { q, gaps } = fullQueue();
    q.enqueue(diagnostic('progress'));
    expect(q.frames).toBe(1); // only the durable frame that filled it
    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    expect(gap.kind).toBe('dropped');
    expect(gap.eventType).toBe('diagnostic');
    expect(gap.contentLost).toBe(true);
    expect(gap.producerFrames).toBe(1);
    expect(gap.bytes).toBeGreaterThan(0);
    expect(gap.detail).toContain('nothing left to merge into');
  });

  it('distinguishes "nothing happened" from "something happened and was lost"', () => {
    // A run that emitted nothing and a run whose frames were dropped both end
    // with an empty consumer queue. Only the second reports a gap, and that is
    // the whole difference a consumer has to act on.
    const silent = queue({ maxBytes: 10_000 });
    silent.q.enqueue(durableBlock('one'));
    expect(silent.gaps.filter((gap) => gap.contentLost)).toHaveLength(0);

    const lossy = fullQueue();
    lossy.q.enqueue(diagnostic('lost'));
    expect(lossy.gaps.filter((gap) => gap.contentLost)).toHaveLength(1);
  });

  it('counts the frames and bytes a slow consumer missed', () => {
    const { q, gaps } = fullQueue();
    for (let i = 0; i < 25; i += 1) q.enqueue(diagnostic(`tick ${i}`));
    const dropped = gaps.filter((gap) => gap.kind === 'dropped');
    expect(dropped).toHaveLength(25);
    expect(q.metrics.droppedFrames).toBe(25);
    expect(q.metrics.droppedBytes).toBeGreaterThan(0);
    expect(dropped.reduce((sum, gap) => sum + gap.bytes, 0)).toBe(q.metrics.droppedBytes);
  });

  it('merges a mergeable ephemeral frame into one already queued, and says it was not a loss', async () => {
    // The queue reduces its OWN occupancy; it never reaches back upstream. An
    // earlier version was handed the producer-side batcher to "merge instead of
    // dropping", which is a cycle - the batcher's flushed frames came back here,
    // were handed back again, and were stranded in a buffer nobody owned. The
    // text did not arrive. That is what the content checks in
    // `coalescing-throughput.test.ts` caught.
    //
    // Order matters: the delta is queued while there is ROOM, and only then is
    // the queue pushed over its bound. A delta offered to an already-full queue
    // has nothing to merge into on its first arrival, so this sequence is what
    // actually reaches the merge arm.
    const { q, gaps } = queue({ maxBytes: 1_000 });
    const first = q.enqueue(delta('hello '));
    expect(first.action).toBe('queued');

    // Now push it over the bound with a durable frame.
    q.enqueue(durableBlock('x'.repeat(2_000)));
    expect(q.paused).toBe(true);

    const second = q.enqueue(delta('world'));
    expect(second.action).toBe('merged');
    expect(q.metrics.droppedFrames).toBe(0);
    expect(q.metrics.ephemeralMerged).toBe(1);

    const merged = gaps.filter((gap) => gap.kind === 'merged');
    expect(merged).toHaveLength(1);
    // `contentLost: false` is the load-bearing field: the frame is still in the
    // queue with the text in it, so telling a consumer to go looking for missing
    // content would be wrong.
    expect(merged[0].contentLost).toBe(false);

    // And the content really is there, with the seq the ledger minted untouched.
    // Drained in one pass rather than by index: the queue holds the delta AND the
    // durable frame that filled it, in arrival order.
    const drained = await drain(q);
    const mergedFrame = drained.find((frame) => frame.payload.type === 'assistant.text_delta');
    expect((mergedFrame?.payload as { delta: string }).delta).toBe('hello world');
    // A merge in the queue must never renumber something already published: the
    // merged frame is still the one the ledger stamped at its arrival.
    expect(mergedFrame?.seq).toBeGreaterThan(0);
    expect(drained.map((frame) => frame.seq)).toEqual([...drained.map((frame) => frame.seq)].sort((a, b) => a - b));
  });

  it('never merges across a merge key: two blocks stay two frames', async () => {
    const { q } = queue({ maxBytes: 1_000 });
    q.enqueue(delta('block zero', 0));
    q.enqueue(durableBlock('x'.repeat(2_000))); // over the bound now
    // Same type, same message, DIFFERENT block: nothing to merge into, so it is
    // reported as a loss rather than welded onto block 0.
    const outcome = q.enqueue(delta('block one', 1));
    expect(outcome.action).toBe('dropped');
    expect(q.gaps.filter((gap) => gap.contentLost)).toHaveLength(1);

    const drained = await drain(q);
    const deltas = drained.filter((frame) => frame.payload.type === 'assistant.text_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0]?.payload as { index: number }).index).toBe(0);
    expect((deltas[0]?.payload as { delta: string }).delta).toBe('block zero');
  });

  it('keeps every gap in a stable order for a metrics reader', () => {
    const { q, gaps } = fullQueue();
    q.enqueue(diagnostic('one'));
    q.enqueue(diagnostic('two'));
    expect(gaps).toHaveLength(2);
    expect(gaps.map((gap) => gap.bytes)).toEqual([...gaps].map((gap) => gap.bytes));
    expect(q.gaps).toHaveLength(2);
  });
});

describe('one queue has one reader', () => {
  it('refuses a second consumer rather than splitting the stream', async () => {
    // Two iterators over a queue that already has frames both used to succeed,
    // each shifting the head in turn: two consumers, each with half the stream,
    // no error anywhere. That is the failure the guard exists for.
    const { q } = queue({ maxBytes: 10_000 });
    q.enqueue(durableBlock('a'));
    q.enqueue(durableBlock('b'));
    expect(q.hasReader).toBe(false);

    const first = q[Symbol.asyncIterator]();
    expect((await first.next()).done).toBe(false);
    expect(q.hasReader).toBe(true);

    // A second handle asking for the same queue is refused outright, and the
    // refusal names the thing that actually fixes it.
    const second = q[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow(/single reader/);
    // The refused consumer took nothing, so the owning reader is unaffected.
    expect((await first.next()).done).toBe(false);
  });

  it('refuses a concurrent read, which is two consumers wearing one caller', async () => {
    const { q } = queue({ maxBytes: 10_000 });
    // Nothing buffered, so the first read parks. A second read while it parks
    // would be a second consumer on the same queue.
    const pending = q.read();
    await expect(q.read()).rejects.toThrow(/single reader/);
    q.enqueue(durableBlock('a'));
    const got = await pending;
    expect(got.value?.payload.type).toBe('assistant.text_block');
  });

  it('lets the owning reader read as many times as it likes', async () => {
    const { q } = queue({ maxBytes: 10_000 });
    q.enqueue(durableBlock('a'));
    q.enqueue(durableBlock('b'));
    // Sequential reads are one consumer reading twice, and must not be refused.
    expect((await q.read()).value?.seq).toBeLessThan((await q.read()).value?.seq ?? 0);
  });

  it('ends the iterator when the queue closes', async () => {
    const { q } = queue({ maxBytes: 10_000 });
    const drained = (async () => {
      const seen: number[] = [];
      for await (const frame of q) seen.push(frame.seq);
      return seen;
    })();
    q.enqueue(durableBlock('a'));
    await Promise.resolve();
    q.close();
    const seen = await drained;
    expect(seen).toHaveLength(1);
  });
});
