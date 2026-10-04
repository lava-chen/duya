/**
 * The durable checkpoint store, and the fence that guards it.
 *
 * ## Why the fence lives in the STORE and not in the caller
 *
 * The failure this prevents is concrete: attempt 1 is killed mid-tool,
 * attempt 2 starts and writes, and then attempt 1's executor — which was never
 * actually dead, only slow, or which had already buffered a frame — commits a
 * terminal. Without a check at the durable boundary the run ends with two
 * writers' histories interleaved and nobody can say which terminal won.
 *
 * A check in the caller cannot fix that, because the caller in this story is
 * the thing that is stale. It is holding a token from before the recovery and
 * will cheerfully use it. So the comparison lives where every write funnels
 * through: {@link InMemoryCheckpointStore.commit}, and
 * {@link CheckpointStore} in the real adapters.
 *
 * Equality is accepted, so one attempt may write many times at its own token.
 * What is refused is a token LOWER than the highest committed — that is a
 * stale attempt, and it is refused regardless of what it is trying to write.
 *
 * ## Why the index and the payload are written together
 *
 * D7.1: `checkpointpayload本体有digest，index和committedcursor同事务/确定barrier；
 * 不记录尚未确认事件为可恢复边界`. An index that could be committed without its
 * payload would advertise a generation whose bytes are not there, and a resume
 * from it would restore nothing while reporting success. So the store refuses
 * to record a `committedSeq` beyond what the ledger actually emitted, and
 * writes payload + index in one call that either lands or does not.
 */

import type { RunId, SessionId } from '@duya/agent-protocol';
import {
  checkpointDigest,
  isFenceCurrent,
  nextFence,
  type RecoveryCheckpoint,
  type RunFence,
  type ToolAttempt,
} from '@duya/agent-protocol';

/** A stored checkpoint plus the digest that authenticates it. */
export interface StoredCheckpoint {
  readonly checkpoint: RecoveryCheckpoint;
  readonly digest: string;
}

/** What a write attempt did, and why when it did nothing. */
export type CommitReceipt =
  | { readonly applied: true; readonly generation: number }
  | {
      readonly applied: false;
      readonly code: 'stale_fence' | 'generation_regression' | 'uncommitted_seq' | 'wrong_run';
      readonly detail: string;
    };

/**
 * The durable side of a checkpoint.
 *
 * Narrow on purpose. It is not the run's event log (`RunEventReader`), not its
 * write queue (`RunPersistence`), and not the pre-image store — those are three
 * different things with three different lifetimes, and a checkpoint that stood
 * in for any of them would be the substitution the plan forbids.
 */
export interface CheckpointStore {
  /** Highest fence token committed for a run. 0 when nothing is committed. */
  highestFence(runId: RunId): number;
  /** The newest committed checkpoint, or `null`. */
  latest(runId: RunId): Promise<StoredCheckpoint | null>;
  /**
   * Commit a checkpoint at a fence.
   *
   * Refuses a stale fence, a generation that goes backwards, and a
   * `committedSeq` this run never emitted.
   */
  commit(input: {
    readonly checkpoint: RecoveryCheckpoint;
    /** The highest `seq` the run has CONFIRMED durable. */
    readonly committedSeq: number;
  }): Promise<CommitReceipt>;
}

/** What the store needs to know about the run's event log, kept separate. */
export interface EmittedSeqProbe {
  /** Has this run emitted this `seq`? */
  emitted(runId: RunId, seq: number): boolean;
}

/**
 * An in-process store that enforces the same rules a durable one must.
 *
 * Mirrors {@link CheckpointStore} deliberately: the fault-injection suite drives
 * real processes against it, so a rule tested here is a rule the durable
 * adapter has to satisfy too. It is NOT a claim that memory is the product's
 * storage — `SqliteCheckpointStore` in the host is — and the two share this
 * file's rules rather than restating them per adapter.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  readonly #rows = new Map<RunId, StoredCheckpoint[]>();
  readonly #probe: EmittedSeqProbe;

  constructor(probe: EmittedSeqProbe) {
    this.#probe = probe;
  }

  highestFence(runId: RunId): number {
    const rows = this.#rows.get(runId);
    if (rows === undefined || rows.length === 0) return 0;
    return rows[rows.length - 1]?.checkpoint.fence ?? 0;
  }

  /** Every committed generation, oldest first. Diagnostics and tests. */
  history(runId: RunId): readonly StoredCheckpoint[] {
    return this.#rows.get(runId) ?? [];
  }

  async latest(runId: RunId): Promise<StoredCheckpoint | null> {
    const rows = this.#rows.get(runId);
    if (rows === undefined || rows.length === 0) return null;
    return rows[rows.length - 1] ?? null;
  }

  async commit(input: {
    readonly checkpoint: RecoveryCheckpoint;
    readonly committedSeq: number;
  }): Promise<CommitReceipt> {
    const cp = input.checkpoint;
    const rows = this.#rows.get(cp.runId);
    const previous = rows === undefined ? null : (rows[rows.length - 1] ?? null);

    // A stale attempt is refused BEFORE anything else is examined, so the
    // refusal cannot be mistaken for a content problem with its payload. A
    // stale writer's bytes are not the issue; the fact that it is stale is.
    if (!isFenceCurrent({ runId: cp.runId, runEpoch: cp.runEpoch, token: cp.fence }, this.highestFence(cp.runId))) {
      return {
        applied: false,
        code: 'stale_fence',
        detail: `fence ${cp.fence} is below the committed high-water mark ${this.highestFence(cp.runId)}; this attempt is stale`,
      };
    }

    if (previous !== null && cp.generation <= previous.checkpoint.generation) {
      return {
        applied: false,
        code: 'generation_regression',
        detail: `generation ${cp.generation} does not advance past ${previous.checkpoint.generation}`,
      };
    }

    // D7.1: a checkpoint may not record an event as its recoverable boundary
    // unless that event was emitted. The ledger already refuses a
    // `checkpoint.saved` pointing at an unemitted seq; this is the store-side
    // half, because a store can be written to directly.
    if (!this.#probe.emitted(cp.runId, input.committedSeq)) {
      return {
        applied: false,
        code: 'uncommitted_seq',
        detail: `committedSeq ${input.committedSeq} was never emitted by run ${cp.runId}`,
      };
    }

    const stored: StoredCheckpoint = { checkpoint: cp, digest: checkpointDigest(cp) };
    if (rows === undefined) {
      this.#rows.set(cp.runId, [stored]);
    } else {
      rows.push(stored);
    }
    return { applied: true, generation: cp.generation };
  }
}

/**
 * Recover a run: a NEW attempt with a NEW fence, over a stored checkpoint.
 *
 * ## Why resume is a new attempt and not a continuation
 *
 * Contract §G: `execution resume形成新attempt/epoch与fence`. The recovered work
 * is the same LOGICAL run and a different ATTEMPT at it, and the difference is
 * load-bearing: a continuation would share the killed attempt's identity, so
 * the two could not be told apart in a log and the stale one could not be
 * fenced.
 *
 * ## What comes back when it cannot
 *
 * A refusal, with a reason, rather than a best-effort resume. The alternatives
 * are all worse: restoring without checking the digest is restoring corruption,
 * and refusing without a reason is a support ticket instead of a diagnosis.
 */
export interface RecoveryOutcome {
  readonly kind: 'recovered';
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** The NEW attempt. Never the one that died. */
  readonly runEpoch: number;
  readonly fence: RunFence;
  readonly base: StoredCheckpoint;
  /** Attempts carried forward, with their outcomes intact. */
  readonly toolAttempts: readonly ToolAttempt[];
  /**
   * Attempts an automatic retry must not touch, by key.
   *
   * Computed HERE rather than left to the caller, so a resume that forgets to
   * check still has the answer in hand. A caller that re-dispatches one of
   * these is a caller that has ignored a computed list, which is a louder
   * mistake than one that never had the list.
   */
  readonly blockedRetryKeys: readonly string[];
  /**
   * What this recovery could NOT do, stated in the outcome.
   *
   * Not a warning field. A resume that cannot continue mid-generation says so
   * in the value the host will read, rather than proceeding as though it can.
   */
  readonly limits: readonly string[];
}

export type RecoveryRefusal =
  | { readonly kind: 'no_checkpoint'; readonly runId: RunId }
  | { readonly kind: 'digest_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'fingerprint_mismatch'; readonly expected: string; readonly actual: string };

export type RecoveryResult = RecoveryOutcome | RecoveryRefusal;

/**
 * Form a new attempt over the run's newest committed checkpoint.
 *
 * `expectedFingerprint` is REQUIRED. Passing it is how a caller states which
 * configuration it believes it is recovering, and comparing it here is what
 * stops a resume from silently running under a different manifest than the one
 * that died — the "silently different run" the protocol exists to prevent.
 */
export async function recoverRun(input: {
  readonly store: CheckpointStore;
  readonly runId: RunId;
  readonly expectedFingerprint: string;
  /** The run's current epoch. The recovered attempt is this plus one. */
  readonly runEpoch: number;
}): Promise<RecoveryResult> {
  const base = await input.store.latest(input.runId);
  if (base === null) return { kind: 'no_checkpoint', runId: input.runId };

  // Verify the bytes before reading a single field out of them. A checkpoint
  // whose digest does not match is not "probably fine" — it is a payload
  // nobody can attribute.
  const actual = checkpointDigest(base.checkpoint);
  if (actual !== base.digest) {
    return { kind: 'digest_mismatch', expected: base.digest, actual };
  }

  if (base.checkpoint.manifestFingerprint !== input.expectedFingerprint) {
    return {
      kind: 'fingerprint_mismatch',
      expected: input.expectedFingerprint,
      actual: base.checkpoint.manifestFingerprint,
    };
  }

  // The new fence is derived from what the STORE has committed, not from the
  // checkpoint's own token. A checkpoint written by a stale attempt is refused
  // at commit time, so trusting its number would trust a value that never
  // applied.
  const nextEpoch = input.runEpoch + 1;
  const fence: RunFence = {
    runId: input.runId,
    runEpoch: nextEpoch,
    token: nextFence([input.store.highestFence(input.runId)]),
  };

  const toolAttempts = base.checkpoint.toolAttempts;
  const limits: string[] = [];
  if (base.checkpoint.model.continuation === 'reconstruct_by_new_attempt') {
    limits.push(
      'the provider adapter cannot continue mid-generation, so the conversation is reconstructed as a new attempt; the resumed run is NOT byte-identical to the killed one',
    );
  }
  if (toolAttempts.some((a) => a.state === 'unknown')) {
    limits.push(
      'at least one tool attempt has an UNKNOWN outcome; it blocks automatic retry and needs reconciliation or a human decision',
    );
  }

  return {
    kind: 'recovered',
    runId: input.runId,
    sessionId: base.checkpoint.sessionId,
    runEpoch: nextEpoch,
    fence,
    base,
    toolAttempts,
    blockedRetryKeys: toolAttempts.filter((a) => !canRetryKey(a)).map((a) => a.attemptKey),
    limits,
  };
}

/**
 * Is this attempt's key one an automatic retry must skip?
 *
 * Deliberately a re-derivation rather than a stored flag: a stored "blocked"
 * column is a second source of truth about the retry rule, and the rule is
 * exactly the thing D7.1 exists to pin down. This mirrors the protocol's
 * `canAutoRetry` and is asserted against it by the test, so a change to one
 * without the other fails rather than diverging quietly.
 */
function canRetryKey(attempt: ToolAttempt): boolean {
  return attempt.state === 'planned';
}
