/**
 * The read side of durable run storage, and the replay decision built on it.
 *
 * ## Why the read side is a separate port from `RunPersistence`
 *
 * `RunPersistence` is the run's WRITE path and stays exactly as T3.1/R1.2 left
 * it — two methods, one batch in, one terminal decision out. Adding a read to
 * it would make the session's own port describe the whole store, and the
 * session would then be the only thing that decides what a consumer may re-read.
 *
 * So replay depends on {@link RunEventReader}, which is READ-ONLY and structural.
 * Two consequences worth stating:
 *
 *  - A replay path cannot write. It cannot mint a `seq`, cannot append, and
 *    cannot touch the ledger, because it holds nothing that could. That is the
 *    "a reconnect only re-reads" rule enforced by the type of the port rather
 *    than by a reviewer's attention.
 *  - The write and read sides may be different objects — an adapter whose reads
 *    go to SQLite while its writes go over `db:request` is a legitimate
 *    deployment — but they must agree on identity, which is the next section.
 *
 * ## Idempotency by event identity is enforced HERE, and only here
 *
 * The question this file has to answer once is: where does "the same event
 * written twice is one event" live? The answer is the store, keyed on
 * `(runId, seq)`, and nowhere else. The reasoning:
 *
 *  - **The store** is the only place that can see a write twice. An append that
 *    is retried after a timeout is indistinguishable, at the store, from the
 *    first attempt that did land. Keying on identity makes the retry a no-op,
 *    which is what lets `RunSession`'s bounded retry be correct at all.
 *  - **The sink** must not dedupe. T3.2 made the emitter the one minting
 *    authority: an inbound envelope's `seq` is REPLACED by the run's own, and a
 *    producer's disagreement is recorded as a diagnostic. A sink that deduped
 *    would be comparing its own minted number against an inbound one and
 *    deciding that a legitimate event is a duplicate — a second numbering rule
 *    sitting one line away from the first.
 *  - **The consumer** may dedupe, and a reconnecting one often must, because
 *    live and replay can legitimately deliver the same event twice. That is
 *    idempotency of CONSUMPTION, not of writing, and it is enforced by the
 *    consumer against the identity the store gave it. Two write-side rules
 *    cannot be reconciled after the fact; a read-side and a write-side rule are
 *    different questions.
 *
 * The one hazard this leaves is that a store keyed on identity will silently
 * drop a *different* payload claiming a `seq` that is already taken. That is
 * impossible while the ledger is the only writer (gapless, one owner per run),
 * so {@link RunEventIdentityConflict} exists to make it a reported fact for an
 * adapter that can detect it, rather than something this file has to prevent.
 */

import type {
  ReplayCursor,
  ReplayRefusal,
  ReplayWindow,
  RunEpoch,
  RunEventEnvelope,
  RunMetrics,
  RunTerminalState,
  SnapshotSource,
} from '@duya/agent-protocol';
import { EMPTY_WINDOW, eventKey, isWithinWindow, refuseForeignCursor, replayWindow } from '@duya/agent-protocol';
import type { RunId } from '@duya/agent-protocol';
import type { RunPersistence } from '../run-session.js';
import type { TranscriptSnapshot } from './transcript-snapshot.js';
import { buildTranscriptSnapshot } from './transcript-snapshot.js';

/** The read side, and the only thing the replay path is allowed to hold. */
export interface RunEventReader {
  /**
   * The durable window for one run.
   *
   * `mintedLatest` is an INPUT, not an output of the store's own data: only the
   * live runtime knows how far its ledger has gone. Passing it in keeps the
   * non-durable tail visible instead of leaving the store to guess.
   */
  readWindow(query: { readonly runId: RunId; readonly mintedLatest: number }): Promise<ReplayWindow>;

  /**
   * Durable events strictly after `afterSeq`, in minted order.
   *
   * Envelopes are returned VERBATIM, carrying the `seq` they were written
   * with. Re-numbering them here would break the identity rule above, so a
   * replay can never produce an event the run did not mint.
   */
  readSince(query: {
    readonly runId: RunId;
    readonly afterSeq: number;
    readonly limit?: number;
  }): Promise<readonly RunEventEnvelope[]>;

  /** The message/block snapshot, or `null` when this store keeps none. */
  readSnapshot(runId: RunId): Promise<TranscriptSnapshot | null>;
}

/**
 * What an append did, per event identity.
 *
 * Only the write path needs this, which is why it is not on `RunPersistence`:
 * the session does not branch on it (it must not — a retry is a retry), and
 * forcing every session caller to consume a receipt would put a fact about
 * storage decisions into the run loop.
 */
export interface AppendReceipt {
  /** Identities newly written. */
  readonly accepted: readonly string[];
  /** Identities already present, with an identical payload. */
  readonly duplicates: readonly string[];
  /** Identities already present with a DIFFERENT payload. */
  readonly conflicts: readonly RunEventIdentityConflict[];
}

/** One `seq` in one run, holding something other than what it used to hold. */
export interface RunEventIdentityConflict {
  readonly key: string;
  readonly runId: RunId;
  readonly seq: number;
  readonly storedType: string;
  readonly offeredType: string;
}

const DEFAULT_READ_LIMIT = 1_000;

/**
 * What a replay request resolved to.
 *
 * Three kinds, and the middle one exists precisely so that "some events are
 * missing" can never be the answer:
 *
 *  - `replay` — the store served everything after the cursor. The consumer can
 *    continue from live with no gap.
 *  - `snapshot_resync` — the cursor is BELOW the window, so the events are gone,
 *    and the store can still describe the run's transcript. The consumer is told
 *    the seq the snapshot covers and where it came from, and it starts from the
 *    snapshot rather than from events. It is a LABELLED fallback, not a silent
 *    substitute: serving snapshot content under a `replay` kind would be the
 *    exact failure this union makes impossible to write, because a consumer
 *    switching on `kind` cannot confuse the two.
 *  - `refused` — the cursor cannot be served and there is nothing to resync
 *    from. `replay_unavailable` for a cursor that aged out; the two scope codes
 *    for a cursor that was never admissible at all.
 */
export type ReplayOutcome =
  | {
      readonly kind: 'replay';
      readonly cursor: ReplayCursor;
      readonly window: ReplayWindow;
      readonly events: readonly RunEventEnvelope[];
      /** Highest seq carried in `events`, or the cursor's `afterSeq` if empty. */
      readonly throughSeq: number;
    }
  | {
      readonly kind: 'snapshot_resync';
      readonly cursor: ReplayCursor;
      readonly window: ReplayWindow;
      readonly snapshot: TranscriptSnapshot;
      readonly snapshotSource: Exclude<SnapshotSource, 'none'>;
      /** The seq whose events are GONE. The consumer is resuming past it. */
      readonly supersededFromSeq: number;
    }
  | {
      readonly kind: 'refused';
      readonly cursor: ReplayCursor;
      readonly window: ReplayWindow;
      readonly refusal: ReplayRefusal;
      readonly detail: string;
    };

/**
 * Decide what to do with one cursor against one run.
 *
 * `async` because it reads, and it is the ONLY function in the replay path that
 * touches storage — the subscription below composes with it and never calls the
 * reader itself, so "what does this runtime replay" has one answer.
 *
 * Order of the three checks is the whole design:
 *
 *  1. **Scope.** A cursor for another run or another epoch is a host bug. It is
 *     refused before any storage is read, so a cross-run probe cannot be used to
 *     enumerate another run's window.
 *  2. **Window.** `isWithinWindow`, whose rule is on the NEXT seq wanted: a
 *     consumer holding `oldest - 1` is missing exactly `oldest`, which the store
 *     still has, and a consumer past the durable latest is up to date — both are
 *     served, the second as a successful EMPTY replay rather than a failure.
 *  3. **Resync.** Only reached when `afterSeq + 1 < oldest`, so the fallback is
 *     triggered by a stated condition and not by a generic error handler. A store
 *     with no snapshot — or one whose events reconstruct no transcript — produces
 *     a refusal instead, because a resync with nothing in it would strand the
 *     consumer with an empty transcript and no signal that it is empty.
 */
export async function resolveReplay(
  reader: RunEventReader,
  target: { readonly runId: RunId; readonly epoch: RunEpoch; readonly mintedLatest: number },
  cursor: ReplayCursor,
  limit = DEFAULT_READ_LIMIT,
): Promise<ReplayOutcome> {
  // Scope FIRST, before anything is read. A cursor naming another run or
  // another attempt is a host bug, and answering it from storage would both
  // report that run's window back to a caller that asked for a different one
  // and turn the replay endpoint into a probe for runs it does not own. The
  // refusal therefore carries an empty window — a consumer that was told its
  // cursor is foreign does not need one, and inventing a window it did not ask
  // for is the leak.
  const scopeRefusal = refuseForeignCursor(cursor, target);
  if (scopeRefusal !== null) {
    return refuse(
      cursor,
      EMPTY_WINDOW,
      scopeRefusal,
      cursor.runId !== target.runId
        ? `cursor names run "${cursor.runId}", the request is for "${target.runId}"`
        : `cursor is for epoch ${cursor.epoch}, this run is at epoch ${target.epoch}`,
    );
  }

  const window = await reader.readWindow({ runId: target.runId, mintedLatest: target.mintedLatest });

  if (isWithinWindow(cursor, window)) {
    const events = await reader.readSince({ runId: target.runId, afterSeq: cursor.afterSeq, limit });
    return {
      kind: 'replay',
      cursor,
      window,
      events,
      throughSeq: events.length === 0 ? cursor.afterSeq : (events[events.length - 1]?.seq ?? cursor.afterSeq),
    };
  }

  const snapshot = await reader.readSnapshot(target.runId);
  if (snapshot === null) {
    return refuse(
      cursor,
      window,
      'replay_unavailable',
      `seq ${cursor.afterSeq + 1} is below the window's oldest seq ${window.oldest}, and no snapshot is stored`,
    );
  }
  // A snapshot that reconstructs nothing is not a resync. A run whose durable
  // log holds only its lifecycle events can derive an empty transcript, and
  // handing that back under `snapshot_resync` would tell the consumer to
  // REPLACE a transcript it has with an empty one — the "resync with nothing in
  // it" failure this module exists to avoid. Refusing is the honest answer: the
  // consumer keeps what it had and knows the events are gone.
  if (snapshot.messages.length === 0 && snapshot.finalized.length === 0) {
    return refuse(
      cursor,
      window,
      'replay_unavailable',
      `seq ${cursor.afterSeq + 1} is below the window's oldest seq ${window.oldest}, and the stored events reconstruct no transcript`,
    );
  }
  return {
    kind: 'snapshot_resync',
    cursor,
    window,
    snapshot,
    snapshotSource: snapshot.source,
    supersededFromSeq: window.oldest,
  };
}

function refuse(
  cursor: ReplayCursor,
  window: ReplayWindow,
  refusal: ReplayRefusal,
  detail: string,
): ReplayOutcome {
  return { kind: 'refused', cursor, window, refusal, detail };
}

/**
 * A store that is both halves at once: the run's `RunPersistence` and a
 * `RunEventReader` over the same rows.
 *
 * ## What it is for
 *
 * It exists so the replay rules can be exercised end to end in one process, and
 * so a CLI or an eval gets a run whose history survives the run. It is NOT a
 * claim that in-memory storage is the product's storage — `RunStore`'s SQLite
 * table is, and this class deliberately mirrors its two load-bearing
 * properties so that a test written here means the same thing it will mean
 * there:
 *
 *  - **keyed on `(runId, seq)`** with an identical-payload duplicate folded
 *    into `duplicates` and a differing payload raised as a conflict. Not
 *    silently ignored: `INSERT OR IGNORE` cannot tell those two cases apart, and
 *    this one can, which is why the conflict is surfaced rather than assumed
 *    impossible.
 *  - **sparse by construction.** Only events the run marks durable are given
 *    here, so the seqs it holds have holes wherever a volatile or ephemeral
 *    event was minted. That is the property the window report exists to
 *    describe, and a store that renumbered to stay contiguous would be
 *    reproducing the bug.
 */
export class InMemoryRunEventStore implements RunPersistence, RunEventReader {
  readonly #rows = new Map<string, Map<number, RunEventEnvelope>>();
  readonly #snapshots = new Map<RunId, TranscriptSnapshot>();

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    const receipt = this.appendSync(envelopes);
    if (receipt.conflicts.length > 0) {
      // Surfaced, not thrown: `RunSession` treats a refusal as a retryable
      // condition and has its own verdict for a store that will not take a
      // batch. Throwing here would let a conflicting seq read as "storage is
      // busy" and be retried forever.
      this.lastConflicts = receipt.conflicts;
    }
    this.lastReceipt = receipt;
  }

  /** The last append's receipt, for tests and diagnostics. */
  lastReceipt: AppendReceipt = { accepted: [], duplicates: [], conflicts: [] };
  /** Conflicts seen by the last append, kept separately to be greppable. */
  lastConflicts: readonly RunEventIdentityConflict[] = [];

  /** The same write, synchronously, for a caller that is not awaiting. */
  appendSync(envelopes: readonly RunEventEnvelope[]): AppendReceipt {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    const conflicts: RunEventIdentityConflict[] = [];
    for (const envelope of envelopes) {
      let rows = this.#rows.get(envelope.runId);
      if (rows === undefined) {
        rows = new Map<number, RunEventEnvelope>();
        this.#rows.set(envelope.runId, rows);
      }
      const existing = rows.get(envelope.seq);
      const key = eventKey(envelope);
      if (existing === undefined) {
        rows.set(envelope.seq, envelope);
        accepted.push(key);
        continue;
      }
      if (existing.payload.type === envelope.payload.type && eventKey(existing) === key) {
        duplicates.push(key);
        continue;
      }
      conflicts.push({
        key,
        runId: envelope.runId,
        seq: envelope.seq,
        storedType: existing.payload.type,
        offeredType: envelope.payload.type,
      });
    }
    return { accepted, duplicates, conflicts };
  }

  /**
   * The terminal decision, recorded but not served.
   *
   * `RunTerminalState` carries no `runId` — the port that delivers it knows the
   * run, and a terminal is the run's own verdict rather than part of its event
   * stream. Storing it here would mean guessing the run from the write queue,
   * so this keeps the method the port requires and nothing more.
   */
  async complete(_terminal: RunTerminalState, _metrics: RunMetrics): Promise<void> {
    /* the terminal row is the Control Plane's, not the event log's */
  }

  async readWindow(query: { readonly runId: RunId; readonly mintedLatest: number }): Promise<ReplayWindow> {
    const rows = this.#rows.get(query.runId);
    if (rows === undefined || rows.size === 0) {
      return replayWindow({
        oldest: 0,
        latest: 0,
        count: 0,
        mintedLatest: query.mintedLatest,
      });
    }
    const seqs = [...rows.keys()].sort((a, b) => a - b);
    return replayWindow({
      oldest: seqs[0] ?? 0,
      latest: seqs[seqs.length - 1] ?? 0,
      count: rows.size,
      mintedLatest: query.mintedLatest,
    });
  }

  async readSince(query: {
    readonly runId: RunId;
    readonly afterSeq: number;
    readonly limit?: number;
  }): Promise<readonly RunEventEnvelope[]> {
    const rows = this.#rows.get(query.runId);
    if (rows === undefined) return [];
    const limit = query.limit ?? DEFAULT_READ_LIMIT;
    return [...rows.values()]
      .filter((envelope) => envelope.seq > query.afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  /**
   * Build the snapshot from the stored rows.
   *
   * Derived rather than stored, because a stored snapshot is a second copy of
   * the transcript that can disagree with the events it came from — and the
   * disagreement would be invisible. The cost is a scan of the durable log per
   * resync; the benefit is that `supersededFromSeq` and the snapshot cannot
   * tell two different stories.
   */
  async readSnapshot(runId: RunId): Promise<TranscriptSnapshot | null> {
    const rows = this.#rows.get(runId);
    if (rows === undefined || rows.size === 0) return null;
    const existing = this.#snapshots.get(runId);
    const throughSeq = [...rows.keys()].sort((a, b) => b - a)[0] ?? 0;
    if (existing !== undefined && existing.throughSeq === throughSeq) return existing;
    const built = buildTranscriptSnapshot({
      runId,
      events: [...rows.values()].sort((a, b) => a.seq - b.seq),
      source: 'durable_transcript',
    });
    this.#snapshots.set(runId, built);
    return built;
  }
}
