/**
 * The replay cursor, and the window it is scoped to.
 *
 * ## Why this is vocabulary and not a resolver
 *
 * Contract §F: `对外resume cursor必须限定run/epoch和可用窗口` — an outward resume
 * cursor must be scoped to a run, an epoch, and an available window. Three
 * things follow, and each one is a different owner's job:
 *
 *  - **scope** (this file) is arithmetic over `(runId, epoch, seq)`. It is pure,
 *    it cannot read storage, and therefore two runtimes cannot answer it
 *    differently. A cursor that is merely "a number" is what made the wire's
 *    `Last-Event-ID` meaningless across turns
 *    (`packages/agent-protocol/src/envelope.ts:14-35`).
 *  - **availability** — whether a given cursor still falls inside the durable
 *    window — belongs to whoever owns storage, because only they know what they
 *    kept. `@duya/agent-runtime` asks a repository and turns the answer into a
 *    decision; this file never guesses.
 *  - **delivery** — how the bytes leave the process — belongs to a transport
 *    and is not modelled here at all.
 *
 * ## Why `epoch` is a number the cursor must carry
 *
 * Contract §G: `execution resume形成新attempt/epoch与fence` — a resumed execution
 * is a NEW attempt on the same logical run, with its own fence. Today execution
 * resume is `unsupported`, so every run is epoch 1 and no run has ever advanced.
 * The field exists anyway, for one reason: **a cursor minted against epoch 1 is
 * meaningless against epoch 2, and the only place that can be caught is where
 * the cursor is decoded.** Adding the field after the first resume lands means
 * the first cursor format has no epoch in it, so it cannot be checked, so the
 * first resume silently hands a consumer another attempt's history.
 *
 * It is an integer rather than a string because it is a counter the runtime
 * owns, exactly like `seq`; a string would put an opaque identifier where a
 * comparable one belongs and invite string comparison of two attempts.
 *
 * ## The wire form is opaque, and that is the point
 *
 * {@link encodeReplayCursor} produces a single string for the `Last-Event-ID`
 * header because that header is a string. It is NOT a bare number: a bare
 * number is the defect this file exists to end. The version prefix is what lets
 * a future format be added without a host having to guess, and the three fields
 * are what make a cursor from another run *detectable* rather than merely
 * wrong. Decoding is total — it returns `null`, never a partial cursor and never
 * a throw — because an unparseable `Last-Event-ID` is a client error to be
 * reported, not a runtime fault.
 */

import type { RunId } from './primitives.js';

/**
 * The attempt number within one logical run.
 *
 * 1 for every run that exists today. Advancing it is what execution resume
 * would do, and contract §G requires a fence when it does.
 */
export type RunEpoch = number;

/** The first epoch. Every run created by this protocol starts here. */
export const FIRST_EPOCH: RunEpoch = 1;

/**
 * A scoped resume cursor.
 *
 * `afterSeq` is EXCLUSIVE, matching `RunStore.listEvents`'s `seq > ?` and
 * `RunSession`'s ledger: a consumer that holds seq 7 and sends
 * `{ afterSeq: 7 }` receives 8 and nothing it already has. Off-by-one here is
 * the duplicate-or-hole failure, so it is stated once and reused by every
 * adapter rather than re-derived per adapter.
 *
 * `afterSeq: 0` means "nothing yet", which is legal and distinct from "epoch
 * mismatch": a fresh subscriber's cursor is not an error.
 */
export interface ReplayCursor {
  readonly runId: RunId;
  readonly epoch: RunEpoch;
  readonly afterSeq: number;
}

/**
 * Where a snapshot came from.
 *
 * Named rather than left as a bare boolean because the consumer's obligation
 * differs per source: a snapshot rebuilt from the durable transcript is the
 * same data the replay would have carried, whereas one taken from a live stream
 * is what the process happened to be holding at the time. Both are honest; a
 * consumer that cannot tell them apart cannot decide whether to trust it.
 */
export type SnapshotSource =
  /** Rebuilt from the durable store: the blocks, without the deltas. */
  | 'durable_transcript'
  /** Read from a live in-memory buffer. Lost when the process dies. */
  | 'live_buffer'
  /** Nothing could be produced. The consumer must restart from empty. */
  | 'none';

/**
 * The durable window for one run.
 *
 * ## `latest` is NOT the run's highest minted seq
 *
 * Durable storage is a SPARSE SUBSEQUENCE of the run's order (contract §F:
 * `durable存储是稀疏子序列，允许seq空洞`). Every event the runtime mints gets a seq;
 * only the durable ones are written. So the highest durable seq and the highest
 * minted seq are different numbers whenever the run ended on, or is currently
 * sitting on, a volatile or ephemeral event — which is the common case, because
 * `assistant.text_delta` and `tool.progress` are both non-durable and both fire
 * constantly.
 *
 * Reporting only one of them is how a consumer gets told it is caught up when it
 * is not. So both are here, and the difference is meaningful:
 * `mintedLatest - latest` is exactly the count of non-durable events after the
 * last durable one. It is not an error and not a gap — those events were never
 * promised to be replayed — but a consumer computing "am I current?" from
 * `latest` alone would be wrong about it, so it is computable instead.
 *
 * `oldest > latest` means the store holds nothing for this run: no durable
 * event has landed yet, or none was ever written.
 */
export interface ReplayWindow {
  /** Lowest durable `seq` still stored. 0 when the store holds nothing. */
  readonly oldest: number;
  /** Highest durable `seq` stored. 0 when the store holds nothing. */
  readonly latest: number;
  /** Highest `seq` the runtime has minted for this run, durable or not. */
  readonly mintedLatest: number;
  /** How many durable events the window holds. Not a range width. */
  readonly count: number;
  /**
   * True when the window is not every minted seq in `[oldest, latest]`.
   *
   * Always true in practice, and stated rather than inferred: the alternative
   * is a consumer assuming a contiguous range, which is the same assumption
   * `ResumeSupport.isReplayable` avoids by comparing two seqs.
   */
  readonly sparse: boolean;
}

/** An empty window: nothing durable has been stored for this run. */
export const EMPTY_WINDOW: ReplayWindow = {
  oldest: 0,
  latest: 0,
  mintedLatest: 0,
  count: 0,
  sparse: false,
};

/**
 * Build a window from the numbers a store reports.
 *
 * `mintedLatest` defaults to `latest` for stores that cannot distinguish the
 * two (an in-memory double, a store that lost the process). That default is
 * deliberately NOT taken for a live runtime: there, a minted-latest above the
 * durable latest is a real, reportable fact, and defaulting it away would hide
 * the non-durable tail behind an assumption.
 */
export function replayWindow(input: {
  readonly oldest: number;
  readonly latest: number;
  readonly count: number;
  readonly mintedLatest?: number;
}): ReplayWindow {
  const mintedLatest = input.mintedLatest ?? input.latest;
  return {
    oldest: input.oldest,
    latest: input.latest,
    mintedLatest: Math.max(mintedLatest, input.latest),
    count: input.count,
    // A single stored event is trivially contiguous, so a 1-wide window is not
    // sparse; an empty one is not sparse either, and saying otherwise would
    // make every fresh run look like it had lost events.
    sparse: input.count > 1 && input.latest - input.oldest + 1 !== input.count,
  };
}

/**
 * Is `cursor`'s position inside `window`, i.e. can the store serve it?
 *
 * `afterSeq >= latest` is TRUE and means "you are current": the consumer holds
 * the last durable event and should be handed live events only. Refusing it
 * would force every consumer that is up to date to fake a failure, and a
 * consumer that has to fabricate errors to keep the protocol moving will
 * eventually fabricate one it should have reported.
 *
 * `afterSeq + 1 < oldest` is the window having moved past the consumer: the seqs
 * between the cursor and `oldest` are gone. That is the only condition that
 * means the store genuinely cannot serve the request, and it is stated on the
 * NEXT seq wanted rather than on the cursor itself — a consumer holding
 * `oldest - 1` is missing exactly `oldest`, which the store still has.
 */
export function isWithinWindow(cursor: ReplayCursor, window: ReplayWindow): boolean {
  // An empty store is its own case, and the generic comparison gets it wrong.
  // `oldest === 0` with a run that has already minted events means NOTHING
  // DURABLE LANDED — a lost batch, or a store that was never written — and the
  // plain comparison reads that as "you are current". It would then hand the
  // consumer an empty event list and a receipt saying it holds everything,
  // which is a silent hole over the whole run.
  if (window.oldest === 0) {
    return window.mintedLatest === 0 && cursor.afterSeq === 0;
  }
  // The test is on the NEXT seq the consumer wants, not on the cursor itself.
  // A consumer holding `oldest - 1` is missing exactly `oldest`, which the
  // store still has, so it is served in full; comparing `afterSeq >= oldest`
  // instead refuses it and forces a consumer that lost nothing to resync.
  const nextWanted = cursor.afterSeq + 1;
  return nextWanted >= window.oldest && cursor.afterSeq <= window.mintedLatest;
}

/**
 * Why a cursor was refused.
 *
 * `replay_unavailable` and `invalid_resume_point` are kept distinct because
 * `resume.ts` already makes that distinction a contract: a host that gets
 * `replay_unavailable` can retry from an older point, and one that gets
 * `invalid_resume_point` cannot. The two scope failures get their own codes
 * because they are a HOST BUG — a cursor minted for a different run or attempt
 * is not a gap in the data, it is a client holding a cursor it should not hold,
 * and reporting it as "unavailable" would send the host looking for missing
 * events that were never lost.
 */
export type ReplayRefusal =
  /** The requested seq has fallen out of the durable window. */
  | 'replay_unavailable'
  /** The cursor belongs to a different run. Never repaired. */
  | 'cursor_run_mismatch'
  /** The cursor belongs to a different attempt of the same run. */
  | 'cursor_epoch_mismatch';

/** Wire format version. Bumped only when the encoding below changes shape. */
export const REPLAY_CURSOR_VERSION = 1;

const CURSOR_PREFIX = 'v';

/**
 * Encode for `Last-Event-ID` (or any single-string header).
 *
 * `runId` is not escaped. A run id containing the separator would produce a
 * string that decodes to a different run than the one it came from, which is
 * precisely the cross-run confusion the field is here to prevent. So a run id
 * carrying the separator is REFUSED at mint time rather than silently encoded,
 * and {@link decodeReplayCursor} refuses the same character class on the way
 * back — two independent checks, because only the second one meets a peer.
 */
export function encodeReplayCursor(cursor: ReplayCursor): string {
  const { runId, epoch, afterSeq } = cursor;
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('a replay cursor needs a runId');
  }
  if (/[.:#]/.test(runId)) {
    throw new TypeError(`runId "${runId}" contains a cursor separator and cannot be encoded`);
  }
  if (!Number.isInteger(epoch) || epoch < FIRST_EPOCH) {
    throw new RangeError(`epoch must be an integer >= ${FIRST_EPOCH}, got ${epoch}`);
  }
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    throw new RangeError(`afterSeq must be an integer >= 0, got ${afterSeq}`);
  }
  return `${CURSOR_PREFIX}${REPLAY_CURSOR_VERSION}.${runId}.${epoch}.${afterSeq}`;
}

/**
 * Decode a cursor from a header value. Total: returns `null` for anything it
 * cannot read, including `null`, an empty string, and a bare number.
 *
 * A bare integer is refused deliberately. It is what the wire sends today, and
 * accepting it would mean this function could return a cursor whose `runId`
 * nobody supplied — a value that would then be checked against a run and, on a
 * guess, accepted. Refusing makes the absence of scoping an error the caller can
 * see.
 */
export function decodeReplayCursor(raw: unknown): ReplayCursor | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [version, runId, epochRaw, afterSeqRaw] = parts;
  if (version !== `${CURSOR_PREFIX}${REPLAY_CURSOR_VERSION}`) return null;
  if (runId === undefined || runId.length === 0 || /[.:#]/.test(runId)) return null;
  const epoch = Number(epochRaw);
  const afterSeq = Number(afterSeqRaw);
  if (epochRaw === undefined || afterSeqRaw === undefined) return null;
  if (!Number.isInteger(epoch) || epoch < FIRST_EPOCH) return null;
  if (!Number.isInteger(afterSeq) || afterSeq < 0) return null;
  return { runId, epoch, afterSeq };
}

/**
 * The scope check, as a refusal or `null` when the cursor is admissible.
 *
 * Order is not arbitrary: the run is checked first because a cursor naming a
 * different run is wrong no matter what its epoch says, and reporting
 * `cursor_epoch_mismatch` for a foreign run would tell a host to retry an epoch
 * it cannot advance.
 */
export function refuseForeignCursor(
  cursor: ReplayCursor,
  target: { readonly runId: RunId; readonly epoch: RunEpoch },
): ReplayRefusal | null {
  if (cursor.runId !== target.runId) return 'cursor_run_mismatch';
  if (cursor.epoch !== target.epoch) return 'cursor_epoch_mismatch';
  return null;
}

/** A cursor for a run's beginning: nothing seen yet. */
export function startOfRun(runId: RunId, epoch: RunEpoch = FIRST_EPOCH): ReplayCursor {
  return { runId, epoch, afterSeq: 0 };
}
