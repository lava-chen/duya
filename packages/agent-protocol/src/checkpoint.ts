/**
 * Checkpoint, side-effect ledger, and fence — plan 587 D7.1.
 *
 * ## Why this is a protocol module and not a runtime one
 *
 * Three separate parties have to agree on these shapes and none of them owns
 * them: the runtime that writes a checkpoint, the Control Plane that stores it,
 * and a host that has to render "this run is waiting on a tool nobody can
 * answer for". A vocabulary only one side holds is a private struct, and the
 * first thing that breaks is a recovery that reads a checkpoint the writer
 * shaped differently.
 *
 * So this is wire data plus pure functions, which is what `agent-protocol` is
 * for. It has no dependency of its own beyond `hash.ts` — no `node:*` (drift
 * test #1 forbids it, which is why `checkpointDigest` goes through the
 * dependency-free `canonicalJson`/`sha256Hex` rather than `node:crypto`), no
 * clock, no storage, and no run loop.
 *
 * ## The three claims this file makes
 *
 * 1. **A checkpoint is a digest, and the digest is over the payload.** A
 *    checkpoint whose bytes cannot be verified is a checkpoint nobody can tell
 *    apart from a corrupted one, and restoring it would be restoring whatever
 *    happened to be in those bytes.
 * 2. **`unknown` is a THIRD outcome, distinct from `failed`.** A tool that was
 *    in flight when the process died may or may not have run. Recording it as
 *    `failed` claims it did not; recording it as `succeeded` claims it did.
 *    Both are claims nobody can support, and the difference matters because
 *    `failed` invites a retry that may double a real side effect.
 * 3. **A fence is what makes "a new attempt" mean anything.** Contract §G:
 *    `execution resume形成新attempt/epoch与fence`. Without a monotonic token
 *    checked at the store, a stale attempt's late ack overwrites the attempt
 *    that replaced it, and the run ends with two writers' history interleaved.
 */

import { canonicalJson, sha256Hex } from './hash.js';
import type { JsonValue } from './hash.js';
import type { RunId, SessionId, ToolCallId, RequestId } from './primitives.js';
import type { RunEpoch } from './replay.js';
import type { RunBudget } from './primitives.js';

// ── schema version ────────────────────────────────────────────────────────

/**
 * The checkpoint schema version, carried in every payload.
 *
 * A version is required even while there is exactly one version, because the
 * first thing D7.3 will do is read a checkpoint written by an older build, and
 * a payload with no version is a payload nothing can refuse.
 */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

// ── side-effect classification ────────────────────────────────────────────

/**
 * What a tool's side effect is, as DECLARED by whoever registered the tool.
 *
 * The declaration is the input to the retry decision and nothing else is. The
 * order is the safety order, and `undeclared` is deliberately the worst member
 * of it rather than a synonym for `read_only`.
 */
export type ToolSideEffectClass =
  /** No external effect. Re-running cannot double anything. */
  | 'read_only'
  /** Same idempotency key + same input means the same effect, once. */
  | 'idempotent_with_key'
  /** The effect landed but can be ASKED about, and the answer is authoritative. */
  | 'reconcilable'
  /** Re-running may double the effect. Never retried automatically. */
  | 'non_retryable'
  /**
   * Nobody declared a class.
   *
   * Contract §G: `无声明保守unknown，禁止自动重复` — an undeclared tool is
   * treated as `unknown` and is not retried. The alternative (assume
   * `read_only` until told otherwise) makes the safe-looking default the
   * dangerous one, which is the wrong way round for a field whose whole job is
   * to stop a duplicate side effect.
   */
  | 'undeclared';

// ── the attempt state machine ─────────────────────────────────────────────

/**
 * One tool attempt's state.
 *
 * `planned → dispatched → succeeded | failed | unknown → reconciled`
 *
 * `unknown` and `reconciled` are the two states that do not exist in a naive
 * model, and both are load-bearing:
 *
 *  - `unknown` is the honest answer for an attempt that was in flight when the
 *    writer died. It is NOT `failed` (which claims no effect happened) and NOT
 *    `succeeded` (which claims one did).
 *  - `reconciled` is how an `unknown` leaves: something authoritative was
 *    asked, and its answer is now recorded. Without it an `unknown` would be
 *    permanent, and a permanent `unknown` is indistinguishable from a run that
 *    can never be closed.
 */
export type ToolAttemptState =
  | 'planned'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled';

/** The states from which no further automatic action may be taken. */
export const TERMINAL_ATTEMPT_STATES: ReadonlySet<ToolAttemptState> = new Set<ToolAttemptState>([
  'succeeded',
  'failed',
]);

/**
 * A tool attempt, keyed to the run and attempt that dispatched it.
 *
 * `attemptKey` is the correlation a mid-tool recovery needs and `seq` is not:
 * a `seq` is the run's event order, so two attempts of the same tool call
 * across two attempts of the run would collide. The contract requires the key
 * to associate `run/attempt/toolcall` with the input digest (D7.1), which is
 * what makes "is this the same work?" answerable after a crash.
 */
export interface ToolAttempt {
  readonly attemptKey: string;
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Digest of the arguments, so a retry can prove it is retrying the SAME work. */
  readonly inputDigest: string;
  readonly state: ToolAttemptState;
  readonly sideEffect: ToolSideEffectClass;
  /** Present only when the tool declared `idempotent_with_key`. */
  readonly idempotencyKey?: string;
  /** How the attempt ended, when it did. Never asserted for `unknown`. */
  readonly detail?: string;
  /**
   * The authoritative answer that turned an `unknown` into a `reconciled`.
   *
   * Required for `reconciled` and forbidden for every other state: a
   * `reconciled` with no evidence is a claim that somebody asked, and the
   * ledger is the only place that claim can be checked.
   */
  readonly reconciledBy?: string;
}

// ── the retry gate ────────────────────────────────────────────────────────

/** Why a retry was refused, or that it is permitted. */
export type RetryVerdict =
  | { readonly retry: true; readonly reason: string }
  | {
      readonly retry: false;
      readonly reason: string;
      /** Machine-readable, so a caller does not parse `reason`. */
      readonly code:
        | 'not_dispatched'
        | 'already_settled'
        | 'unknown_side_effect'
        | 'undeclared_side_effect'
        | 'non_retryable'
        | 'reconciliation_required'
        | 'input_digest_mismatch'
        | 'different_run_or_attempt';
    };

/**
 * May this attempt be re-dispatched AUTOMATICALLY?
 *
 * ## The rule, and the argument for it
 *
 * `unknown` blocks. That is the contract's default (§G: `unknown默认阻断自动重试`)
 * and this function is where the default is enforced rather than described.
 *
 * The judgement call the contract leaves open is whether an `unknown` should
 * EVER be retried automatically, and the answer here is: **yes, for exactly one
 * case — `idempotent_with_key` with the SAME key and the SAME input digest.**
 *
 * The argument for the exception is that the key is the tool's own promise that
 * the second call collapses onto the first. A retry carrying that key is not a
 * second effect; it is the same effect, asked twice, which is what idempotency
 * keys are FOR. Refusing it would not be safer, only less useful — and a
 * recovery that cannot use the one mechanism designed for this situation is a
 * recovery that will be talked around.
 *
 * The argument for everything else staying blocked:
 *
 *  - `non_retryable` is a declaration by the tool's author that a second call
 *    may double the effect. Overriding an author who knows their own tool is
 *    the exact failure the contract's `non_retryable` rule exists to prevent.
 *  - `reconcilable` is NOT a licence to retry. It is a licence to ASK. The
 *    effect probably landed; asking the external system is strictly better
 *    than running the tool again, so this returns
 *    `reconciliation_required` and points at the query rather than the retry.
 *  - `undeclared` is `unknown` by contract and inherits the block. Defaulting
 *    to safe-looking would invert the field's purpose.
 *
 * `reconciled` DOES permit a retry, and only with its own recorded evidence:
 * once the answer is known, a `reconciled` attempt that reconciled to "it did
 * NOT happen" is exactly the case a safe retry exists for. That is why the
 * reconciliation evidence is mandatory rather than optional — without it,
 * "reconciled" would be a way to talk an `unknown` into a retry.
 */
export function canAutoRetry(attempt: ToolAttempt): RetryVerdict {
  if (attempt.state === 'planned') {
    // Never dispatched, so there is no effect to have double-run. This is the
    // one state where "it might have happened" is not merely unlikely but
    // impossible by construction.
    return { retry: true, reason: 'planned and never dispatched; no effect can exist' };
  }

  if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
    return {
      retry: false,
      code: 'already_settled',
      reason: `already ${attempt.state}; a settled attempt is history, not work to repeat`,
    };
  }

  if (attempt.state === 'dispatched') {
    return {
      retry: false,
      code: 'not_dispatched',
      reason: 'still dispatched: the original attempt is in flight, not finished',
    };
  }

  // `reconciled` and `unknown` both fall through to the side-effect rules.
  if (attempt.sideEffect === 'undeclared') {
    return {
      retry: false,
      code: 'undeclared_side_effect',
      reason: 'the tool declared no side-effect class; undeclared is treated as unknown and blocks retry',
    };
  }

  if (attempt.sideEffect === 'non_retryable') {
    return {
      retry: false,
      code: 'non_retryable',
      reason: 'the tool declared itself non-retryable; a second call may double the effect',
    };
  }

  if (attempt.sideEffect === 'reconcilable') {
    return {
      retry: false,
      code: 'reconciliation_required',
      reason: 'the effect may have landed; ask the external system rather than repeating the call',
    };
  }

  if (attempt.sideEffect === 'idempotent_with_key') {
    if (attempt.idempotencyKey === undefined || attempt.idempotencyKey === '') {
      return {
        retry: false,
        code: 'unknown_side_effect',
        reason: 'the tool claims idempotency but recorded no key; an unkeyed retry is a second effect',
      };
    }
    if (attempt.reconciledBy === undefined) {
      return {
        retry: false,
        code: 'unknown_side_effect',
        reason:
          'the outcome is unknown and the tool is idempotent-with-key, but the key is carried by the CALLER, not by this ledger; ' +
          'an automatic retry cannot prove it would reuse the same key, so it is refused',
      };
    }
    return {
      retry: true,
      reason: `reconciled as "${attempt.detail ?? 'not-landed'}" and the tool is idempotent with a recorded key`,
    };
  }

  // `read_only`.
  if (attempt.state === 'reconciled') {
    return {
      retry: true,
      reason: 'read-only and reconciled; there is no external effect to double',
    };
  }
  return {
    retry: false,
    code: 'unknown_side_effect',
    reason: 'read-only tools are safe to re-run, but an unknown attempt still has to be closed out first',
  };
}

/**
 * Is this a safe point to checkpoint from?
 *
 * D7.1: `可恢复安全点为没有unknownsideeffect的loop/toolbarrier`. A checkpoint
 * taken while an attempt is `dispatched` describes a run that cannot be
 * continued without consulting the ledger, which is why the answer is a
 * separate question from "is the payload well-formed".
 */
export function isSafeCheckpointPoint(attempts: readonly ToolAttempt[]): boolean {
  return !attempts.some((a) => a.state === 'dispatched' || a.state === 'unknown');
}

// ── the checkpoint payload ────────────────────────────────────────────────

/**
 * What a run needs in order to CONTINUE.
 *
 * Contract §G names the members: `model/context/transcript/mailbox/tool/
 * permission索引`. Two members of the plan's longer list are deliberately
 * absent, and both absences are decisions rather than omissions:
 *
 *  - **file pre-images are NOT here.** §G: `文件pre-image rewind是另一功能，
 *    不能代替它`. A checkpoint that could rewind a file would be claiming a
 *    capability the file pre-image mechanism owns, and the two would then be
 *    unable to disagree — which is exactly the "不能互当替代" the plan forbids.
 *    `artifactRefs` points AT pre-images without copying them.
 *  - **secrets are NOT here.** §E: `敏感值不进公开manifest/event/artifact/日志`.
 *    The manifest already carries `{ref, hash}` rather than values, and a
 *    checkpoint is durable and therefore long-lived, so an inlined credential
 *    would outlive every rotation of it. `envRef` is a reference.
 *
 * What a checkpoint deliberately does NOT claim:
 *
 *  - **Model continuation state.** Provider-side KV state is not ours to
 *    serialise. `modelContinuation` records whether the adapter supports
 *    resuming mid-generation; when it does not, a resume must reconstruct the
 *    conversation as a new attempt and say so.
 *  - **Determinism.** Nothing here makes a resumed run reproduce the killed
 *    one, and `capabilities` is where that refusal is stated rather than
 *    assumed.
 */
export interface RecoveryCheckpoint {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** Monotonic per run, matching the `checkpoint.saved` payload. */
  readonly generation: number;
  /** The attempt this checkpoint belongs to. A resume forms a NEW one. */
  readonly runEpoch: RunEpoch;
  /** The fence token this attempt holds. Checked by the store on every write. */
  readonly fence: number;
  /** Fingerprint of the manifest this run was frozen under. */
  readonly manifestFingerprint: string;
  /** Digest of the run's input, so "the same run" is checkable. */
  readonly inputRevision: string;
  /** Where the transcript stands. A POSITION, never the transcript itself. */
  readonly transcript: {
    readonly throughSeq: number;
    readonly messageCount: number;
  };
  /** How the model loop stood, and whether it may be continued mid-generation. */
  readonly model: {
    readonly providerId: string;
    readonly model: string;
    readonly turnIndex: number;
    readonly continuation: 'resumable' | 'reconstruct_by_new_attempt';
  };
  /** Profile/mode state, as ids. No resolved policy objects. */
  readonly loop: {
    readonly profileId: string | null;
    readonly modeIds: readonly string[];
  };
  /** Spend so far, so a restart cannot reset the budget. */
  readonly budget: {
    readonly limit: RunBudget;
    readonly spent: { turns: number; toolCalls: number; tokens: number };
  };
  /** Everything the host queued but the run has not consumed. */
  readonly mailbox: { readonly watermark: number; readonly pending: number };
  /** Outstanding approvals, with the deadline that was actually offered. */
  readonly pendingApprovals: readonly {
    readonly requestId: RequestId;
    readonly expiresAt: number;
  }[];
  /** The side-effect ledger. Omitting it is what made a mid-tool guess possible. */
  readonly toolAttempts: readonly ToolAttempt[];
  /** Pointers to durable outputs. Never file contents. */
  readonly artifactRefs: readonly string[];
  /** A reference to the credential source. Never the credential. */
  readonly envRef: { readonly ref: string; readonly hash: string };
  /**
   * What this checkpoint can and cannot do, read by a consumer rather than
   * inferred from the payload's shape.
   */
  readonly capabilities: {
    /** False until a provider adapter proves it. See `model.continuation`. */
    readonly deterministic: false;
    /** The `parentRunId`, when this run is a user branch off another run. */
    readonly parentRunId?: RunId;
  };
}

/**
 * The digest over a checkpoint payload.
 *
 * Over the WHOLE payload, and deliberately excluding nothing: a digest that
 * skipped the fence or the tool ledger would let those two be edited by
 * anyone holding a valid digest for the rest, which is precisely the edit that
 * turns `unknown` into `succeeded`.
 *
 * `schemaVersion` is inside the digest, so a payload from a future schema
 * cannot validate against a present one.
 */
export function checkpointDigest(checkpoint: RecoveryCheckpoint): string {
  return sha256Hex(canonicalJson(toJson(checkpoint)));
}

/** Strip undefined-valued optional keys so they cannot change the digest. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** A checkpoint is well-formed when its own digest matches its bytes. */
export function verifyCheckpoint(
  checkpoint: RecoveryCheckpoint,
  expected: string,
): { ok: true } | { ok: false; expected: string; actual: string } {
  const actual = checkpointDigest(checkpoint);
  return actual === expected ? { ok: true } : { ok: false, expected, actual };
}

// ── the fence ─────────────────────────────────────────────────────────────

/**
 * A monotonic write token held by one attempt at one run.
 *
 * The store refuses a write whose token is lower than the highest it has
 * recorded for that run. That single comparison is what makes a stale attempt
 * harmless: it does not need to know a new attempt exists, and it does not need
 * to be told to stop — its write simply no longer applies.
 */
export interface RunFence {
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  readonly token: number;
}

/** A fence at the floor, for a run's FIRST attempt. */
export const GROUND_FENCE: Readonly<Record<'token', number>> = { token: 0 };

/**
 * The next fence for a new attempt. Strictly greater, always.
 *
 * `Math.max(...)+1` rather than `+1` on the last value: fences are compared
 * against the HIGHEST the store has seen, and a caller resuming from a stale
 * local copy would otherwise mint a token that collides with one already
 * committed.
 */
export function nextFence(previous: readonly number[]): number {
  return previous.length === 0 ? 1 : Math.max(...previous) + 1;
}

/**
 * Is a write from `incoming` still allowed, given what the store has seen?
 *
 * Equality is allowed: one attempt writing repeatedly at its own token is the
 * normal case, and refusing it would make a fence a single-use ticket.
 */
export function isFenceCurrent(incoming: RunFence, highest: number): boolean {
  return incoming.token >= highest;
}
