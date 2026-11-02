/**
 * The structured Session input and the per-session control lease (R1.0).
 *
 * ## Why this file exists now
 *
 * The R1.0 audit found that the product already has THREE input paths and none
 * of them speaks the same language:
 *
 * | Path | Durable carrier | Idempotency key | Order | Receipt |
 * | --- | --- | --- | --- | --- |
 * | User chat turn | run row + rollout | none | run seq | `StartAgentRunResult` (accepted/stage) |
 * | TUI steer | `mailbox_items` (`kind='followup'`) | `(session_id, client_msg_id)` | `(priority, created_at)` | mailbox row state |
 * | TUI queue | process-local array | none | array order | none |
 * | Bot dispatch | `bot_inbox` | `dedup_key` | `lane` priority, `created_ms` | `bot_dispatch_receipts` |
 *
 * So there is no single place that can answer "was this input accepted, and
 * where is it now?" — and the plan's P2 contract (a receipt that distinguishes
 * `persisted` / `queued` / `delivered` / `consumed` / `rejected`) has nothing
 * to attach to. These types are that vocabulary. They are ADDITIVE: no
 * production path uses them yet, and R1.1 wires the first one.
 *
 * ## The identity is DERIVED, and the request does not carry one
 *
 * The request has NO `actor` field, and the lease request has NO `holder`
 * field. That is the whole point: the Host derives the identity from the
 * authenticated caller, the Bot mandate, or a trusted Plugin binding, and
 * never from a field a model, a plugin or a client wrote into a payload.
 *
 * An earlier draft of this file put `actor` on the request and described it
 * as "filled in by the Host" — which is incoherent, because the request IS
 * what the client sends. It would have invited exactly the failure the plan
 * names: "the user said this" and "a model said the user said this" would
 * have been indistinguishable in the durable record, and the control lease
 * decides who may direct a Session.
 *
 * So the derived identity appears on the OUTCOME instead: the receipt echoes
 * the actor the Host recorded, and the lease names the holder the Host
 * granted it to. A caller can therefore see who was recorded — and cannot
 * forge it. Drift test #25 fails the build if an identity field reappears on
 * either request.
 *
 * ## `requestId` is the dedup key, and it is the caller's
 *
 * The existing carriers each invented their own key (`client_msg_id`,
 * `dedup_key`, `dispatch_key`), and each is scoped to one path. `requestId` is
 * the one that has to work across paths, because a retried submit must be
 * recognisable as the same request no matter which transport carried it. The
 * Host owns the mapping from `requestId` to whatever its store calls it; the
 * protocol only fixes the shape.
 *
 * ## `expectedRunId` / `expectedTurnId` are how a stale instruction is refused
 *
 * `SteerAgentRunInput` already carries `expectedTurnId` and states that the
 * Host REJECTS on mismatch rather than guessing (`run-api.ts`). This file
 * generalises that to every intent, and adds the Run dimension, because the
 * failure mode is the same: an instruction written for one turn must not land
 * in the next one.
 *
 * ## The lease is a REVISION CAS, not a flag
 *
 * `revision` increments on every grant. A holder proves it still holds the
 * lease by presenting the revision it was given, and the Host checks that
 * revision atomically against the stored one before dispatching anything. A
 * boolean "is a lease held" cannot answer the question that matters — "is THIS
 * holder still the one that was granted" — and that question is what makes a
 * takeover safe: the previous holder's in-flight instruction must fail the
 * check instead of racing the new holder.
 *
 * The lease is NOT the worker execution fence. That fence (`RunAttemptFence`)
 * rejects stale ATTEMPTS of one run; this lease decides who may direct the
 * SESSION. They are separate facts with separate authorities, and the product
 * already has three different epoch counters for similar-looking things
 * (`bot_inbox.lease_epoch`, `bot_scheduler_owners.epoch`, `runs.epoch`).
 * Keeping this one in its own type is the point.
 *
 * ## Why these are types and not behaviour
 *
 * The package is a transport-neutral leaf with zero runtime dependencies
 * (drift test #1). The storage, the atomicity and the wiring belong to the
 * Host; the vocabulary belongs here. Nothing in this file may grow a
 * dependency on the Host, the runtime, or the database.
 */

import type { FileAttachment } from './file-attachment.js';

/** What the caller wants to happen to this input. */
export const SESSION_INPUT_INTENTS = ['steer', 'enqueue', 'interrupt'] as const;
export type SessionInputIntent = (typeof SESSION_INPUT_INTENTS)[number];

/**
 * How far an input actually got.
 *
 * The five stages are the ones a caller can actually PROVE, which is why
 * there is no `accepted` and no `delivered`-without-object. A stage is
 * reported only when the Host can point at the durable fact that supports it.
 *
 * `persisted` — durably recorded; the Host will not lose it.
 * `queued` — held for a later turn because the session could not take it now.
 * `delivered` — handed to a run for delivery.
 * `consumed` — applied inside a run and its effect is part of that run.
 * `rejected` — refused; `reason` says why.
 */
export const SESSION_INPUT_STAGES = [
  'persisted',
  'queued',
  'delivered',
  'consumed',
  'rejected',
] as const;
export type SessionInputStage = (typeof SESSION_INPUT_STAGES)[number];

/**
 * Who sent an input.
 *
 * Derived by the Host from the authenticated caller. See the file header for
 * why a submitted actor is not trustworthy.
 */
export const SESSION_INPUT_ACTOR_KINDS = ['user', 'bot', 'plugin', 'channel', 'system'] as const;
export type SessionInputActorKind = (typeof SESSION_INPUT_ACTOR_KINDS)[number];

/** The derived identity of the sender. */
export interface SessionInputActor {
  readonly kind: SessionInputActorKind;
  /** Stable id within the kind: a bot id, a plugin id, a channel thread id. */
  readonly id?: string;
}

/**
 * A reference to something the input depends on, by identity rather than by
 * payload.
 *
 * The contract carries attachments by reference for the same reason: a
 * reference has a version, a scope and an auditable source, and none of those
 * survive being inlined into a prompt.
 */
export interface SessionContextRef {
  /** What kind of thing is referenced. */
  readonly kind: 'file' | 'skill' | 'plugin' | 'mcp' | 'app' | 'task' | 'agent';
  /** Stable id of the referenced thing. */
  readonly id: string;
  /** Which scope the reference resolves against, when the kind has scopes. */
  readonly scope?: string;
  /** Version or digest of the referenced thing, when it has one. */
  readonly version?: string;
}

/**
 * A request to put one instruction into a Session.
 *
 * Additive: this is the shape R1.1's input service accepts. Existing callers
 * keep using `startAgentRun` and the mailbox until they are migrated.
 *
 * There is deliberately NO identity field here. See the file header: the
 * Host derives who sent the input, and the receipt echoes it.
 */
export interface SessionInputRequest {
  readonly sessionId: string;
  /** Caller-chosen idempotency key. Retrying a submit reuses it. */
  readonly requestId: string;
  readonly intent: SessionInputIntent;
  readonly content: string;
  readonly attachments?: readonly FileAttachment[];
  readonly contextRefs?: readonly SessionContextRef[];
  /** The run this instruction was written for. Absent means "the current one". */
  readonly expectedRunId?: string;
  /** The turn this instruction was written for. Absent means "the current one". */
  readonly expectedTurnId?: string;
}

/**
 * What happened to a submitted input.
 *
 * `requestId` is echoed so a caller that lost the response can look the
 * outcome up instead of resubmitting and hoping.
 */
export interface SessionInputReceipt {
  /** Host-minted id of the durable record. */
  readonly inputId: string;
  readonly requestId: string;
  readonly sessionId: string;
  /**
   * The identity the Host DERIVED for this input.
   *
   * Echoed, never supplied. A caller can see who was recorded and cannot
   * claim to be someone else.
   */
  readonly actor: SessionInputActor;
  readonly stage: SessionInputStage;
  /** Present when `stage` is `rejected`. */
  readonly reason?: string;
  /** The run the input was delivered to or consumed by, once known. */
  readonly runId?: string;
  /** The turn the input landed in, once known. */
  readonly turnId?: string;
}

/**
 * Who holds the right to direct a Session.
 *
 * Distinct from the worker execution fence: the fence rejects stale attempts
 * of one run, this decides who may start the next instruction.
 */
export const SESSION_CONTROL_HOLDER_KINDS = ['user', 'bot', 'plugin'] as const;
export type SessionControlHolderKind = (typeof SESSION_CONTROL_HOLDER_KINDS)[number];

/**
 * A per-session lease on the right to direct that session.
 *
 * At most one holder at a time. Granting a new lease bumps `revision`, which
 * invalidates the previous holder's `expectedRevision` checks.
 */
export interface SessionControlLease {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly holder: {
    readonly kind: SessionControlHolderKind;
    readonly id: string;
  };
  /** Bumped on every grant. The holder presents the one it was given. */
  readonly revision: number;
  /** The request that granted this lease. */
  readonly requestId: string;
  /** Absolute expiry in epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * What a lease request asks for.
 *
 * There is NO `holder` field. The holder is the authenticated caller, derived
 * by the Host — a request that named its own holder would let a plugin ask
 * for a user's lease. The granted lease names the holder the Host recorded.
 */
export interface SessionControlLeaseRequest {
  readonly sessionId: string;
  readonly requestId: string;
  /**
   * The revision the caller believes is current.
   *
   * Present when the caller is extending an existing lease; absent when the
   * caller is asking for the session to itself.
   */
  readonly expectedRevision?: number;
  /** Requested lifetime in milliseconds. The Host may shorten it. */
  readonly ttlMs: number;
}

/**
 * The narrow input surface a client uses to direct a Session.
 *
 * Every method returns a receipt-shaped result rather than throwing, because
 * "the instruction was refused" is an ordinary outcome that a caller has to
 * branch on, not an exceptional one.
 */
export interface HostSessionInputApiV1 {
  /**
   * Accept an instruction.
   *
   * A repeated `requestId` returns the original receipt instead of creating
   * a second input.
   */
  submitInput(request: SessionInputRequest): Promise<SessionInputReceipt>;
  /** Look up the receipt of a previous submit by its request id. */
  readInputReceipt(sessionId: string, requestId: string): Promise<SessionInputReceipt | null>;
  /** Take the right to direct the session, or fail if someone else holds it. */
  acquireControlLease(request: SessionControlLeaseRequest): Promise<SessionControlLease | null>;
  /** Give the right back. The holder must present its revision. */
  releaseControlLease(sessionId: string, revision: number): Promise<boolean>;
  /** Read the current lease, if any. Read-only: it grants no rights. */
  readControlLease(sessionId: string): Promise<SessionControlLease | null>;
}
