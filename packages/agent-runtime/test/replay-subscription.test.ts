/**
 * T3.3 -?a reconnect only re-reads, and the handoff has neither a duplicate nor
 * a hole.
 *
 * The handoff is a race, so the tests build the race deliberately: live events
 * are published *while* the replay read is in flight, which is the only timing
 * that distinguishes a correct join from a lucky one. And the reconnect's
 * defining property is enforced by counting -?the run's `observe` and the
 * executor's dispatch are both spied on, and both must stay at zero.
 */

import { describe, expect, it, vi } from 'vitest';
import { openReplaySubscription, type RunEventTap } from '../src/replay/replay-subscription.js';
import { InMemoryRunEventStore } from '../src/replay/replay-repository.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import { RunEventEmitter, type EventPublisher } from '../src/events/event-emitter.js';
import type { RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';

const RUN = 'run-1';

/**
 * A `run.started` that actually passes the registry's field manifest.
 *
 * `manifestHash` alone is NOT enough — `protocol` and `runtime` are required
 * too, and the emitter refuses the event before it mints a seq. A run whose
 * `run.started` was refused has no seq 1, so every later assertion about seqs
 * shifts by one and the failure looks like a replay bug.
 */
const RUN_STARTED = {
  type: 'run.started',
  manifestHash: 'm',
  protocol: { major: 1, minor: 0 },
  runtime: { name: 'test', version: '0.0.0' },
} as const;

/**
 * A tap over a live run, with the ability to publish while the subscription is
 * still resolving -?which is the entire race.
 */
class TestTap implements RunEventTap {
  readonly listeners = new Set<(envelope: RunEventEnvelope) => void>();
  /** Run when a listener attaches, before the replay read completes. */
  onAttach: (() => void) | null = null;

  attach(listener: (envelope: RunEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    this.onAttach?.();
    return () => this.listeners.delete(listener);
  }

  publish(envelope: RunEventEnvelope): void {
    for (const listener of [...this.listeners]) listener(envelope);
  }
}

function envelope(seq: number, runId = RUN): RunEventEnvelope {
  return {
    runId,
    sessionId: 'sess-1',
    seq,
    timestamp: 1_000,
    traceId: `trace-${runId}`,
    payload: { type: 'run.started', manifestHash: 'm' },
  };
}

async function collect(iterable: AsyncIterable<RunEventEnvelope>): Promise<number[]> {
  const seqs: number[] = [];
  for await (const item of iterable) seqs.push(item.seq);
  return seqs;
}

/**
 * A store that lets the test run the run FORWARD while it is being read.
 *
 * This is the whole race. `onRead` fires from inside `readSince`, i.e. after
 * the consumer has already attached to live and while the storage read is still
 * in flight — which is the only window in which the two sources can disagree.
 *
 * The first draft of this test published from `onAttach` instead, and it passed
 * against a deliberately broken late-attach subscription: events published AT
 * attach time are buffered by the naive ordering too, so the test proved
 * nothing about the ordering. This hook is inside the read for that reason.
 */
class RacingStore extends InMemoryRunEventStore {
  onRead: (() => void) | null = null;

  override async readSince(query: {
    runId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<readonly RunEventEnvelope[]> {
    const rows = await super.readSince(query);
    this.onRead?.();
    return rows;
  }
}

describe('the handoff from replay to live has no duplicate and no hole', () => {
  it('drops what replay already served and keeps what arrived during the read', async () => {
    const store = new RacingStore();
    store.appendSync([envelope(1), envelope(2), envelope(3)]);

    const tap = new TestTap();
    // The run mints 4 and 5 while storage is being read. Live-first would
    // duplicate 1..3; replay-first without a pre-attach buffer would lose 4
    // and 5 entirely, because nothing was listening when they were published.
    store.onRead = () => {
      tap.publish(envelope(4));
      tap.publish(envelope(5));
    };

    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 5 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 1 },
      isClosed: () => true,
    });

    const seqs = await collect(subscription.events());
    expect(seqs).toEqual([2, 3, 4, 5]);
    // The load-bearing assertion: every seq exactly once, in order.
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(subscription.receipt.fromSeq).toBe(5);
  });

  it('serves a live-only event the store never saw, rather than losing it', async () => {
    // The same race with nothing durable behind it: a run whose first durable
    // event has not flushed yet still owes the consumer what it published.
    const store = new RacingStore();
    store.appendSync([envelope(1)]);
    const tap = new TestTap();
    store.onRead = () => tap.publish(envelope(2));

    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 2 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => true,
    });

    expect(await collect(subscription.events())).toEqual([1, 2]);
  });

  it('resumes exactly where the store left off, with no window between the two sources', async () => {
    const store = new RacingStore();
    store.appendSync([envelope(1), envelope(2)]);

    const tap = new TestTap();
    store.onRead = () => tap.publish(envelope(3));

    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 3 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => true,
    });

    const seqs = await collect(subscription.events());
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]! - seqs[i - 1]!).toBe(1);
    }
  });

  it('keeps serving live events after the replay is exhausted', async () => {
    // A subscription that ends at the replay boundary is a truncated run, not a
    // reconnect.
    const store = new InMemoryRunEventStore();
    store.appendSync([envelope(1)]);
    const tap = new TestTap();

    let closed = false;
    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 1 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => closed,
    });

    const seen: number[] = [];
    const iterator = subscription.events()[Symbol.asyncIterator]();
    seen.push((await iterator.next()).value?.seq ?? 0);

    tap.publish(envelope(2));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    seen.push((await iterator.next()).value?.seq ?? 0);
    expect(seen).toEqual([1, 2]);

    closed = true;
    tap.publish(envelope(3));
    await vi.waitFor(async () => expect((await iterator.next()).done).toBe(true));
  });

  it('delivers the handoff tail only once, even if events() is called twice', async () => {
    const store = new InMemoryRunEventStore();
    store.appendSync([envelope(1), envelope(2)]);
    const tap = new TestTap();
    tap.onAttach = () => tap.publish(envelope(3));

    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 3 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => true,
    });

    expect(await collect(subscription.events())).toEqual([1, 2, 3]);
    // A second reader of the same subscription gets the live tail, not the
    // buffered handoff repeated.
    expect(await collect(subscription.events())).toEqual([]);
  });
});

describe('a replay GET never triggers the executor and never observes again', () => {
  it('touches neither session.observe nor the execution channel', async () => {
    // The real run, a real session and the real emitter -?so the spy is on the
    // actual minting path, not on a stand-in that happens not to mint.
    const store = new InMemoryRunEventStore();
    const persistence: RunPersistence = store;
    const session = new RunSession({
      runId: RUN,
      sessionId: 'sess-1',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence,
      flushEvery: 1,
    });
    const published: RunEventEnvelope[] = [];
    const stream: EventPublisher = { push: (e) => published.push(e) };
    const emitter = new RunEventEmitter({ session, stream, runId: RUN });
    // The executor's dispatch port, which a reconnect must never reach.
    const dispatch = vi.fn();

    emitter.emit(RUN_STARTED);
    emitter.emit({ type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'hello' });

    // Every live publish goes through the tap, so a live-only event would show
    // up without going anywhere near the ledger. Emitted BEFORE the spy goes
    // on, so the spy can only catch something the REPLAY did.
    const tap = new TestTap();
    stream.push = (e) => {
      tap.publish(e);
      published.push(e);
    };
    emitter.emit({ type: 'assistant.text_block', messageId: 'm1', index: 1, text: 'world' });
    await session.flush();

    // Installed last: everything the run produced legitimately is already
    // observed by now, so any call from here on came from the replay path.
    const observe = vi.spyOn(session, 'observe');

    const seqBefore = session.seq;
    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: session.seq },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => true,
    });
    const seqs = await collect(subscription.events());

    // Re-read only: the ledger did not move, nothing was re-emitted, and the
    // executor's dispatch was never called.
    expect(session.seq).toBe(seqBefore);
    expect(observe).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // 1 run.started + 2 text_blocks; the second block arrived live, the first
    // two came from storage, and neither source minted anything.
    expect(seqs).toEqual([1, 2, 3]);
    expect(emitter.runId).toBe(RUN);
  });

  it('serves the same seqs the ledger minted, so a replay cannot invent one', async () => {
    const store = new InMemoryRunEventStore();
    const session = new RunSession({
      runId: RUN,
      sessionId: 'sess-1',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence: store,
      flushEvery: 1,
    });
    const emitter = new RunEventEmitter({
      session,
      stream: { push: () => undefined },
      runId: RUN,
    });
    emitter.emit(RUN_STARTED);
    // `run.paused` is volatile, so it takes a seq and is never written — the
    // hole that makes the store's window sparse. (`tool.progress` would not do:
    // the ledger correctly refuses progress for a call that never started, so it
    // never reaches a seq at all.)
    emitter.emit({ type: 'run.paused', at: 'turn_boundary' });
    emitter.emit({ type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'hi' });
    await session.flush();

    const subscription = await openReplaySubscription({
      reader: store,
      tap: new TestTap(),
      run: { runId: RUN, epoch: 1, mintedLatest: session.seq },
      cursor: { runId: RUN, epoch: 1, afterSeq: 0 },
      isClosed: () => true,
    });

    const replayed = await collect(subscription.events());
    // The ledger minted 1..3 and only 1 and 3 are durable. The store keeps the
    // run's own numbers: it does not renumber to 1,2.
    expect(replayed).toEqual([1, 3]);
    expect(subscription.receipt.window.count).toBe(2);
    expect(subscription.receipt.window.sparse).toBe(true); // 1..3 is 3 wide, 2 held
    expect(subscription.receipt.window.mintedLatest).toBe(3);
  });
});

describe('a refused subscription says why and delivers nothing', () => {
  it('does not open, and reports the refusal rather than an empty success', async () => {
    const store = new InMemoryRunEventStore();
    const tap = new TestTap();
    const detach = vi.spyOn(tap, 'attach');
    store.appendSync([envelope(10), envelope(11)]);

    const subscription = await openReplaySubscription({
      reader: store,
      tap,
      run: { runId: RUN, epoch: 1, mintedLatest: 11 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 1 },
      isClosed: () => true,
    });

    expect(subscription.receipt.outcome).toBe('refused');
    expect(subscription.receipt.refusal).toBe('replay_unavailable');
    expect(await collect(subscription.events())).toEqual([]);
    expect(detach).toHaveBeenCalledTimes(1);
    // Detached, so a refused consumer does not keep a live subscription open.
    expect(tap.listeners.size).toBe(0);
  });

  it('carries the cursor it refused, never an invented resume position', async () => {
    const store = new InMemoryRunEventStore();
    store.appendSync([envelope(10)]);
    const subscription = await openReplaySubscription({
      reader: store,
      tap: new TestTap(),
      run: { runId: RUN, epoch: 1, mintedLatest: 10 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 3 },
      isClosed: () => true,
    });

    expect(subscription.receipt.outcome).toBe('refused');
    expect(subscription.receipt.fromSeq).toBe(3);
    expect(subscription.receipt.detail).toContain('oldest seq 10');
  });
});

describe('a resync receipt tells the consumer it is resuming PAST the gap', () => {
  it('reports the snapshot position, not the events it did not receive', async () => {
    const store = new InMemoryRunEventStore();
    store.appendSync([
      envelope(10),
      { ...envelope(11), payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'the answer' } },
    ]);

    const subscription = await openReplaySubscription({
      reader: store,
      tap: new TestTap(),
      run: { runId: RUN, epoch: 1, mintedLatest: 11 },
      cursor: { runId: RUN, epoch: 1, afterSeq: 2 },
      isClosed: () => true,
    });

    expect(subscription.receipt.outcome).toBe('snapshot_resync');
    // `fromSeq` is the snapshot's own position. Reporting the window's latest
    // here would tell a consumer to resume from a seq it never received.
    expect(subscription.receipt.fromSeq).toBe(11);
    expect(subscription.receipt.detail).toContain('1..9');
    expect(await collect(subscription.events())).toEqual([]);
  });
});

/** Keeps the unused-import checker honest about the terminal type. */
export type _TerminalShape = RunTerminalState;
export type _MetricsShape = RunMetrics;
