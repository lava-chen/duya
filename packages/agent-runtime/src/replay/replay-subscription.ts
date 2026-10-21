/**
 * Opening a subscription on a run that may already be streaming.
 *
 * ## The problem this solves
 *
 * A consumer that reconnects asks for "everything after seq N". Two things are
 * happening at once -?the run is still producing events, and the store is
 * holding the history. Reading them in the wrong order produces exactly one of
 * two failures, and which one you get depends on timing rather than on code:
 *
 *  - **live first, then replay.** The live stream has already delivered seq
 *    40..60; replay then delivers 20..60. Every event after the cursor is
 *    delivered TWICE. A consumer that appends rather than replaces sees the
 *    answer twice.
 *  - **replay first, then live.** Replay is read at seq 20..40. While reading,
 *    the run mints 41..55 into a queue nobody was watching. Attaching after the
 *    read loses them: a HOLE, with a cursor that says "you are at 40" and a run
 *    that has already moved past 55.
 *
 * So neither order is safe and the choice cannot be made by a caller. This
 * module makes the safe order the only one available: attach to live FIRST,
 * buffer what arrives, then replay, then drain the buffer past the seq the
 * replay reached. The buffer is what turns the race into a total order.
 *
 * ## What this module deliberately cannot do
 *
 * It holds a {@link RunEventReader} and a live tap. It holds NO ledger, no
 * session, no emitter and no execution channel, so:
 *
 *  - it cannot mint a `seq` (nothing here calls the ledger),
 *  - it cannot append (the reader is read-only), and
 *  - it cannot start an executor.
 *
 * That is the mechanical form of contract §F's `stream reconnect只补读，不重执行`
 * -?a reconnect only re-reads and never re-executes. The type of the port is
 * the enforcement; a test that counts `session.observe` calls and executor
 * dispatches is what keeps the port honest.
 *
 * ## The live tap is a TEE, and this module says so
 *
 * `RunEventStream` is a single-reader queue: two consumers iterating it would
 * steal each other's events. A subscription therefore cannot take the stream
 * itself -?the host must supply a {@link RunEventTap} that fans one run's
 * events out to this subscriber and any other. Who owns that fan-out is a
 * transport decision (T3.5's single-reader-or-fanout question); what this module
 * requires is only that the tap can be attached and detached, and that events
 * already published before `attach` are the store's to answer for.
 *
 * The consequence is stated because it is a real gap, not a nicety: an event
 * minted between the last durable flush and `attach` is in neither the replay
 * read nor the tap, and would be missed. {@link RunEventSubscription.receipt}
 * therefore carries the `fromSeq` the consumer must resume from, so the host can
 * re-issue rather than assume continuity.
 */

import type { ReplayCursor, ReplayRefusal, ReplayWindow, RunEventEnvelope } from '@duya/agent-protocol';
import type { RunEpoch, RunId } from '@duya/agent-protocol';
import type { ReplayOutcome, RunEventReader } from './replay-repository.js';
import { resolveReplay } from './replay-repository.js';

/** Attaching to a run's live events. A tee, not the stream itself. */
export interface RunEventTap {
  /**
   * Deliver every envelope published from now on. Must NOT replay anything: an
   * event published before this call is storage's to answer for, and delivering
   * it from both sides is the duplicate this module is built to prevent.
   */
  attach(listener: (envelope: RunEventEnvelope) => void): () => void;
}

/** What the consumer is told before it reads a single event. */
export interface RunEventSubscriptionReceipt {
  readonly runId: RunId;
  readonly epoch: RunEpoch;
  /** How the subscription was satisfied. */
  readonly outcome: 'replay' | 'snapshot_resync' | 'refused';
  readonly window: ReplayWindow;
  readonly cursor: ReplayCursor;
  /**
   * The seq the consumer must resume from if it reconnects again.
   *
   * Equals `throughSeq` on a normal replay, and the snapshot's `throughSeq`
   * after a resync -?which is AHEAD of the events it was given, because the
   * superseded range is gone. Reporting the window's `latest` there instead
   * would tell a consumer to resume from a seq it never received.
   */
  readonly fromSeq: number;
  /** Present only when `outcome` is `refused`. */
  readonly refusal?: ReplayRefusal;
  readonly detail?: string;
}

/** One subscription's events, plus how it started. */
export interface RunEventSubscription {
  readonly receipt: RunEventSubscriptionReceipt;
  /**
   * Events in minted order, from the store and then from live, with no
   * duplicate and no hole across the handoff.
   *
   * Ends when the run is closed. It does not end when the replay is exhausted:
   * a subscription that stops at the replay boundary is a truncated run, not a
   * reconnect.
   */
  events(): AsyncIterable<RunEventEnvelope>;
  /** Detach from live. Idempotent; also called when the run closes. */
  close(): void;
}

export interface OpenSubscriptionInput {
  readonly reader: RunEventReader;
  readonly tap: RunEventTap;
  readonly run: { readonly runId: RunId; readonly epoch: RunEpoch; readonly mintedLatest: number };
  readonly cursor: ReplayCursor;
  /** Set when the run has closed; the subscription ends after draining. */
  readonly isClosed?: () => boolean;
  readonly limit?: number;
}

/**
 * Open one subscription: replay first from storage, then live, no gap either way.
 *
 * The attach happens BEFORE the storage read, and that ordering is the entire
 * mechanism. It costs one buffer of whatever arrives during the read, and it is
 * what makes the handoff correct for a run that is actively producing.
 */
export async function openReplaySubscription(input: OpenSubscriptionInput): Promise<RunEventSubscription> {
  const buffered: RunEventEnvelope[] = [];
  let liveListener: ((envelope: RunEventEnvelope) => void) | null = null;
  let detach: (() => void) | null = null;
  // Attached BEFORE anything is read. A late attach is the hole: an event
  // published during the read has no listener, and the consumer's cursor says
  // it is current when it is not.
  detach = input.tap.attach((envelope) => {
    if (liveListener === null) {
      buffered.push(envelope);
      return;
    }
    liveListener(envelope);
  });

  const outcome = await resolveReplay(input.reader, input.run, input.cursor, input.limit);

  const receipt = receiptFor(outcome, input.run);
  if (outcome.kind === 'refused') {
    detach();
    detach = null;
    return {
      receipt,
      events: () => emptyStream(),
      close: () => undefined,
    };
  }

  // The point the two sources meet. Everything the live tap buffered at or
  // below this seq was already served from storage, and everything above it is
  // the consumer's missing tail.
  const handoffSeq =
    outcome.kind === 'replay' ? outcome.throughSeq : outcome.snapshot.throughSeq;
  const live = buffered.filter((envelope) => envelope.seq > handoffSeq).sort((a, b) => a.seq - b.seq);
  // Drained on the first `events()` call and emptied; a second call must not
  // deliver the handoff tail a second time.
  let pending = live;
  // The replayed events are seeded once, not once per `events()` call: a second
  // reader of the same subscription gets the live tail, not a second copy of the
  // history the store already served.
  let seeded = false;
  // The highest seq this subscription has taken responsibility for. It is above
  // `outcome.throughSeq` whenever the tap buffered events during the read, and
  // those events ARE delivered — so a resume point below them would hand them
  // over a second time on the next reconnect.
  const handoffHigh = live.length === 0 ? handoffSeq : (live[live.length - 1]?.seq ?? handoffSeq);

  return {
    receipt: { ...receipt, fromSeq: handoffHigh },
    events: () => {
      let delivering = false;
      const queue: RunEventEnvelope[] = [];
      const waiters: Array<() => void> = [];
      let closed = false;

      const push = (envelope: RunEventEnvelope): void => {
        queue.push(envelope);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter();
      };

      liveListener = (envelope: RunEventEnvelope) => {
        push(envelope);
      };
      // Seeded in this order, and it is the whole subscription: the events the
      // store served, then the live tail the store did not have. Anything the
      // tap buffered at or below `handoffSeq` was already filtered out when the
      // handoff point was computed, so the two sources cannot overlap.
      if (!seeded) {
        seeded = true;
        for (const envelope of outcome.kind === 'replay' ? outcome.events : []) push(envelope);
        // Anything that arrived while the consumer was working through the
        // replay is drained next, in seq order, before the tap's next delivery
        // is put in front of it.
        for (const envelope of pending) push(envelope);
        pending = [];
      }

      return {
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<RunEventEnvelope>> {
            // Re-entrancy guard: a single-reader subscription whose `attach`
            // fan-out would otherwise interleave two `next()` calls.
            if (delivering) throw new Error('a replay subscription has a single reader');
            delivering = true;
            try {
              for (;;) {
                const next = queue.shift();
                if (next !== undefined) return { value: next, done: false };
                if (closed) return { value: undefined, done: true };
                if (input.isClosed?.() === true && queue.length === 0) {
                  closed = true;
                  return { value: undefined, done: true };
                }
                await new Promise<void>((resolve) => waiters.push(resolve));
              }
            } finally {
              delivering = false;
            }
          },
          async return(): Promise<IteratorResult<RunEventEnvelope>> {
            closed = true;
            return { value: undefined, done: true };
          },
        }),
      };
    },
    close: () => {
      liveListener = null;
      detach?.();
      detach = null;
    },
  };
}

function receiptFor(
  outcome: ReplayOutcome,
  run: { readonly runId: RunId; readonly epoch: RunEpoch },
): RunEventSubscriptionReceipt {
  switch (outcome.kind) {
    case 'replay':
      return {
        runId: run.runId,
        epoch: run.epoch,
        outcome: 'replay',
        window: outcome.window,
        cursor: outcome.cursor,
        fromSeq: outcome.throughSeq,
      };
    case 'snapshot_resync':
      return {
        runId: run.runId,
        epoch: run.epoch,
        outcome: 'snapshot_resync',
        window: outcome.window,
        cursor: outcome.cursor,
        fromSeq: outcome.snapshot.throughSeq,
        detail: `events 1..${outcome.supersededFromSeq - 1} are outside the window; resume from the snapshot`,
      };
    case 'refused':
      return {
        runId: run.runId,
        epoch: run.epoch,
        outcome: 'refused',
        window: outcome.window,
        cursor: outcome.cursor,
        // A refusal has no position to resume from. The cursor it refused IS
        // the position, so it is echoed rather than invented -?a consumer must
        // not be handed a `fromSeq` it did not ask for after a failure.
        fromSeq: outcome.cursor.afterSeq,
        refusal: outcome.refusal,
        detail: outcome.detail,
      };
  }
}

async function* emptyStream(): AsyncIterable<RunEventEnvelope> {
  /* a refused subscription delivers nothing, and says so in its receipt */
}
