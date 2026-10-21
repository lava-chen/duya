/**
 * T3.4 — the tee, for a host that needs a UI reader AND a persistence reader.
 *
 * The property: two subscribers, two independent queues, each getting the whole
 * stream, each with its OWN backpressure policy - and neither able to starve the
 * other. A fast UI and a slow persistence reader must diverge visibly (through
 * `DeliveryGap`s) rather than by one of them quietly stealing frames.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { FanOutBroker } from '../src/events/stream-fanout.js';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import type { DeliveryGap } from '../src/events/backpressure.js';

const RUN = 'run-1';
let seq = 0;

function frame(type: string, extra: Record<string, unknown> = {}): RunEventEnvelope {
  seq += 1;
  return {
    runId: RUN,
    sessionId: 's1',
    seq,
    timestamp: 1_000,
    traceId: 't1',
    payload: { type, ...extra } as unknown as RunEvent,
  };
}

const durableBlock = (i: number) => frame('assistant.text_block', { messageId: 'm', index: i, text: `t${i}` });
const diagnostic = (i: number) => frame('diagnostic', { level: 'info', message: `tick ${i}` });

describe('each subscriber gets its own queue and the whole stream', () => {
  it('delivers every frame to both subscribers', async () => {
    const broker = new FanOutBroker(RUN);
    const ui = broker.subscribe({ maxBytes: 1_000_000 });
    const persistence = broker.subscribe({ maxBytes: 1_000_000 });

    for (let i = 0; i < 10; i += 1) broker.publish(durableBlock(i));

    const uiSeen: number[] = [];
    const persistSeen: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      uiSeen.push(((await ui.queue.read()).value as RunEventEnvelope).seq);
      persistSeen.push(((await persistence.queue.read()).value as RunEventEnvelope).seq);
    }
    expect(uiSeen).toEqual(persistSeen);
    expect(uiSeen).toHaveLength(10);
    expect(new Set(uiSeen).size).toBe(10);
  });

  it('keeps the two readers independent: one stalling does not steal from the other', async () => {
    const broker = new FanOutBroker(RUN);
    const fast = broker.subscribe({ maxBytes: 1_000_000 });
    const slow = broker.subscribe({ maxBytes: 1_000_000 });

    for (let i = 0; i < 5; i += 1) broker.publish(durableBlock(i));
    // The slow reader reads nothing at all.
    const fastSeen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      fastSeen.push(((await fast.queue.read()).value as RunEventEnvelope).seq);
    }
    expect(fastSeen).toHaveLength(5);
    // And it still has all five waiting for it. Nothing was consumed on its behalf.
    expect(slow.queue.frames).toBe(5);
  });

  it('gives each subscriber its own bound, and a slow one loses only its own frames', async () => {
    const gaps: DeliveryGap[] = [];
    const broker = new FanOutBroker(RUN);
    const ui = broker.subscribe({ maxBytes: 1_000_000 });
    // The persistence reader has a tiny bound and reports its own gaps. It gets
    // NO batcher, so an ephemeral frame has nowhere to merge and is dropped once
    // its own queue is actually full - visibly, on that subscriber alone.
    const persistence = broker.subscribe({ maxBytes: 1_000, onGap: (gap) => gaps.push(gap) });

    for (let i = 0; i < 20; i += 1) {
      broker.publish(diagnostic(i));
      if (i % 5 === 0) broker.publish(durableBlock(i));
    }

    // The UI kept everything: 20 diagnostics plus 4 blocks.
    expect(ui.queue.frames).toBe(24);
    expect(ui.queue.metrics.droppedFrames).toBe(0);
    expect(ui.queue.metrics.bufferedEphemeral).toBe(20);

    // The persistence reader dropped only what IT could not hold. Its durable
    // blocks are all still there - the bound never evicts one.
    const persistedDurable = persistence.queue.frames;
    expect(persistence.queue.metrics.droppedFrames).toBeGreaterThan(0);
    expect(persistence.queue.metrics.droppedFrames + persistedDurable).toBe(24);
    expect(gaps.filter((gap) => gap.contentLost).length).toBe(
      persistence.queue.metrics.droppedFrames,
    );
    // And nothing durable was among the losses.
    expect(gaps.some((gap) => gap.contentLost && gap.eventType !== 'diagnostic')).toBe(false);
  });

  it('stops delivering to a detached subscriber', async () => {
    const broker = new FanOutBroker(RUN);
    const ui = broker.subscribe({ maxBytes: 1_000_000 });
    const persistence = broker.subscribe({ maxBytes: 1_000_000 });
    persistence.detach();

    for (let i = 0; i < 3; i += 1) broker.publish(durableBlock(i));
    expect(ui.queue.frames).toBe(3);
    expect(persistence.queue.frames).toBe(0);
    expect(broker.subscribers).toBe(1);
  });

  it('attaches a bare listener in the RunEventTap shape T3.3 consumes', async () => {
    const broker = new FanOutBroker(RUN);
    const seen: number[] = [];
    const detach = broker.attach((envelope) => seen.push(envelope.seq));
    broker.publish(durableBlock(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);

    detach();
    broker.publish(durableBlock(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(broker.subscribers).toBe(0);
  });

  it('closes every subscriber at once', async () => {
    const broker = new FanOutBroker(RUN);
    const a = broker.subscribe({ maxBytes: 100 });
    const b = broker.subscribe({ maxBytes: 100 });
    broker.close();
    expect(broker.subscribers).toBe(0);
    expect((await a.queue.read()).done).toBe(true);
    expect((await b.queue.read()).done).toBe(true);
  });
});

describe('two handles cannot fight over one queue, because the tee is the supported answer', () => {
  it('refuses a second consumer and points at the broker', async () => {
    const queue = new BoundedEventQueue({ runId: RUN, maxBytes: 1_000_000 });
    queue.enqueue(durableBlock(1));
    const first = queue[Symbol.asyncIterator]();
    await first.next();
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow(/FanOutBroker/);
  });
});
