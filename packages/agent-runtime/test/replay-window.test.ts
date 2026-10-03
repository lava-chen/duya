/**
 * T3.3 — what a replay request resolves to, and what the store guarantees.
 *
 * The properties: a cursor from another run is refused BEFORE storage is read, a
 * cursor that has aged out resyncs from a snapshot or is refused — never both
 * silently — a consumer that is already current gets an empty replay rather than
 * an error, and a replayed event keeps the identity it was written with.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryRunEventStore,
  resolveReplay,
  type RunEventReader,
} from '../src/replay/replay-repository.js';
import { buildTranscriptSnapshot } from '../src/replay/transcript-snapshot.js';
import type { ReplayCursor, RunEventEnvelope } from '@duya/agent-protocol';
import { eventKey } from '@duya/agent-protocol';

const RUN = 'run-1';

/** An envelope with the seq the runtime minted, and a type the registry knows. */
function env(seq: number, type = 'run.started', runId = RUN): RunEventEnvelope {
  return {
    runId,
    sessionId: 'sess-1',
    seq,
    timestamp: 1_000,
    traceId: `trace-${runId}`,
    payload: { type, ...(type === 'run.started' ? { manifestHash: 'm' } : {}) } as RunEventEnvelope['payload'],
  };
}

/** A store holding `seqs` as durable events for RUN. */
function storeWith(seqs: readonly number[], mintedLatest = seqs[seqs.length - 1] ?? 0): InMemoryRunEventStore {
  const store = new InMemoryRunEventStore();
  store.appendSync(seqs.map((seq) => env(seq)));
  void mintedLatest;
  return store;
}

const target = (mintedLatest: number) => ({ runId: RUN, epoch: 1, mintedLatest });
const cursorAt = (afterSeq: number, overrides: Partial<ReplayCursor> = {}): ReplayCursor => ({
  runId: RUN,
  epoch: 1,
  afterSeq,
  ...overrides,
});

describe('a cursor from another run is refused without reading storage', () => {
  it('refuses, and never touches the reader', async () => {
    // A cross-run probe must not be able to enumerate another run's window,
    // which is why the scope check precedes every storage read.
    const readWindow = vi.fn(async () => {
      throw new Error('storage must not be read for a foreign cursor');
    });
    const reader: RunEventReader = {
      readWindow,
      readSince: vi.fn(async () => []),
      readSnapshot: vi.fn(async () => null),
    };

    const outcome = await resolveReplay(reader, target(10), cursorAt(0, { runId: 'run-2' }));

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.refusal).toBe('cursor_run_mismatch');
    expect(readWindow).not.toHaveBeenCalled();
  });

  it('refuses an epoch mismatch within the right run', async () => {
    const store = storeWith([1, 2, 3]);
    const outcome = await resolveReplay(store, target(3), cursorAt(1, { epoch: 2 }));

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.refusal).toBe('cursor_epoch_mismatch');
    // A retryable-sounding refusal would send a host looking for lost events.
    expect(outcome.kind === 'refused' && outcome.refusal).not.toBe('replay_unavailable');
  });
});

describe('a cursor inside the window is served, holes and all', () => {
  it('replays the sparse subsequence verbatim, keeping each event identity', async () => {
    // 3 and 7 were ephemeral/volatile, so the durable log has holes. They are
    // NOT renumbered into a contiguous range: the run minted those numbers and
    // only the run may spend them.
    const store = storeWith([1, 2, 4, 5, 8]);
    const outcome = await resolveReplay(store, target(8), cursorAt(2));

    expect(outcome.kind).toBe('replay');
    if (outcome.kind !== 'replay') return;
    expect(outcome.events.map((e) => e.seq)).toEqual([4, 5, 8]);
    expect(outcome.window.oldest).toBe(1);
    expect(outcome.window.latest).toBe(8);
    expect(outcome.window.count).toBe(5);
    expect(outcome.window.sparse).toBe(true);
    // Identity is `(runId, seq)` — the same key the durable store is keyed on.
    expect(eventKey(outcome.events[0]!)).toBe(`${RUN}#4`);
    expect(outcome.throughSeq).toBe(8);
  });

  it('serves a consumer that is already current as an EMPTY replay', async () => {
    const store = storeWith([1, 2, 3]);
    const outcome = await resolveReplay(store, target(3), cursorAt(3));

    expect(outcome.kind).toBe('replay');
    if (outcome.kind !== 'replay') return;
    expect(outcome.events).toEqual([]);
    expect(outcome.throughSeq).toBe(3);
  });

  it('serves a cursor past the durable latest, because the tail is not durable', async () => {
    // Durable 1..3, minted through 6. A consumer at 6 is up to date as far as
    // replay goes and must be handed live events, not an error.
    const store = storeWith([1, 2, 3], 6);
    const outcome = await resolveReplay(store, target(6), cursorAt(6));

    expect(outcome.kind).toBe('replay');
    expect(outcome.window.mintedLatest).toBe(6);
  });
});

describe('a cursor that aged out resyncs from a snapshot, and says where from', () => {
  it('serves a snapshot with its source and the seq that is gone', async () => {
    const store = storeWith([10, 11, 12]);
    // A snapshot has to exist, so the store is given durable text to derive one
    // from — that is the path T3.3 claims is sufficient.
    store.appendSync([
      {
        ...env(13, 'assistant.text_block'),
        payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'the answer' },
      } as RunEventEnvelope,
    ]);

    const outcome = await resolveReplay(store, target(13), cursorAt(2));

    expect(outcome.kind).toBe('snapshot_resync');
    if (outcome.kind !== 'snapshot_resync') return;
    expect(outcome.snapshotSource).toBe('durable_transcript');
    expect(outcome.supersededFromSeq).toBe(10);
    expect(outcome.snapshot.messages[0]?.id).toBe('m1');
    // The consumer is told it is resuming PAST the superseded range rather than
    // being handed events it does not have.
    expect(outcome.detail).toBeUndefined();
  });

  it('refuses when there is nothing to resync from, instead of serving an empty one', async () => {
    const store = storeWith([10, 11]);
    const readSnapshot = vi.fn(async () => null);
    const outcome = await resolveReplay(
      { readWindow: (q) => store.readWindow(q), readSince: (q) => store.readSince(q), readSnapshot },
      target(11),
      cursorAt(1),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.refusal).toBe('replay_unavailable');
    // A "resync" with nothing in it would strand the consumer with an empty
    // transcript and no signal that it is empty.
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('names the boundary in the refusal, so "some events are missing" never stands alone', async () => {
    const store = storeWith([10, 11]);
    const outcome = await resolveReplay(
      { readWindow: (q) => store.readWindow(q), readSince: (q) => store.readSince(q), readSnapshot: async () => null },
      target(11),
      cursorAt(1),
    );

    expect(outcome.kind === 'refused' && outcome.detail).toContain('oldest seq 10');
    expect(outcome.window.oldest).toBe(10);
  });

  it('never produces a silent gap for an empty store over a minted run', async () => {
    // Every durable batch lost: the store holds nothing, the run minted 25.
    const store = new InMemoryRunEventStore();
    const outcome = await resolveReplay(store, target(25), cursorAt(0));

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.refusal).toBe('replay_unavailable');
  });
});

describe('a replayed identical event keeps its identity, and only the store decides', () => {
  it('folds a duplicate append into `duplicates` and writes no second row', () => {
    const store = new InMemoryRunEventStore();
    const first = store.appendSync([env(1), env(2)]);
    expect(first.accepted).toEqual([`${RUN}#1`, `${RUN}#2`]);

    // The Control Plane retrying an append it was not sure landed. Same
    // identity, same payload: idempotent, which is what makes the bounded retry
    // in `RunSession` correct at all.
    const second = store.appendSync([env(1), env(2)]);
    expect(second.accepted).toEqual([]);
    expect(second.duplicates).toEqual([`${RUN}#1`, `${RUN}#2`]);
    expect(second.conflicts).toEqual([]);
  });

  it('reports a DIFFERENT payload claiming a taken seq, rather than ignoring it', () => {
    // `INSERT OR IGNORE` cannot tell these two cases apart. A store that folds a
    // conflicting payload into `duplicates` would report a success it did not
    // have, and the ledger's gapless guarantee would hide behind it.
    const store = new InMemoryRunEventStore();
    store.appendSync([env(1, 'run.started')]);
    const receipt = store.appendSync([env(1, 'turn.started')]);

    expect(receipt.duplicates).toEqual([]);
    expect(receipt.conflicts).toHaveLength(1);
    expect(receipt.conflicts[0]?.storedType).toBe('run.started');
    expect(receipt.conflicts[0]?.offeredType).toBe('turn.started');
  });

  it('keys identity on the run, so two runs at the same seq do not collide', async () => {
    const store = new InMemoryRunEventStore();
    store.appendSync([env(1, 'run.started', 'run-a'), env(1, 'run.started', 'run-b')]);

    const a = await resolveReplay(store, { runId: 'run-a', epoch: 1, mintedLatest: 1 }, cursorAt(0, { runId: 'run-a' }));
    const b = await resolveReplay(store, { runId: 'run-b', epoch: 1, mintedLatest: 1 }, cursorAt(0, { runId: 'run-b' }));

    expect(a.kind === 'replay' && a.events[0]?.runId).toBe('run-a');
    expect(b.kind === 'replay' && b.events[0]?.runId).toBe('run-b');
  });
});

describe('the snapshot a resync serves is derived, never a second copy', () => {
  it('is rebuilt from the stored events, so it cannot disagree with them', async () => {
    const store = new InMemoryRunEventStore();
    store.appendSync([
      { ...env(1), payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'first' } } as RunEventEnvelope,
      { ...env(3), payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: 'corrected' } } as RunEventEnvelope,
    ]);

    const snapshot = await store.readSnapshot(RUN);
    expect(snapshot?.throughSeq).toBe(3);
    // Last durable write wins, because the snapshot has no memory of its own.
    expect(snapshot?.messages[0]?.content).toEqual([{ type: 'text', text: 'corrected' }]);
  });

  it('is null for a run the store never wrote', async () => {
    expect(await new InMemoryRunEventStore().readSnapshot('never-existed')).toBeNull();
  });

  it('reports the source it was built from', () => {
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [{ ...env(1), payload: { type: 'assistant.text_block', messageId: 'm', index: 0, text: 'x' } } as RunEventEnvelope],
      source: 'live_buffer',
    });
    expect(snapshot.source).toBe('live_buffer');
  });
});
