/**
 * The Host's Session input surface (R1.2).
 *
 * ## What this is
 *
 * The one place a caller can put an instruction INTO a session and get a
 * receipt back. Before this there were three input paths with three
 * idempotency keys, three orderings and three receipts, and a caller that
 * lost the response could not tell "it was refused" from "it never arrived".
 *
 * ## The identity is DERIVED, never submitted
 *
 * `SessionInputRequest` carries no actor, and neither does the lease request.
 * The Host binds the identity when it assembles this service — from the
 * authenticated caller, the Bot mandate or a trusted Plugin binding. A
 * request that named its own actor would let a plugin post as a user, and the
 * control lease is exactly the thing that decides who may speak for a
 * session. So the receipt ECHOES the actor the Host recorded and the caller
 * can read it but not choose it.
 *
 * ## The lease is checked BEFORE the delivery, not after
 *
 * A lease says who may direct the session right now. Checking it after the
 * instruction had already been handed to a run would make the lease a
 * description of the past. So the check happens between "durably recorded"
 * and "handed over", and a refused instruction is recorded as `rejected` with
 * the reason — the refusal is a fact about the session, and it has to be
 * durable like any other.
 *
 * The check is a read, so it is not atomic with the delivery that follows
 * it. The window is the delivery call. What closes the window properly is
 * the revision CAS on the lease itself: a takeover bumps the revision, and
 * the holder that lost it can no longer extend — so the two sides cannot
 * both believe they hold the lease for longer than one delivery.
 *
 * ## The delivery is a PORT, not a call
 *
 * The service does not know how a turn starts. It knows that an accepted
 * input has to end up somewhere — handed to a run, held for a later turn, or
 * refused — and the Host fills that in. A port that took a function would
 * have to be filled in by the caller, and the caller would have to NAME the
 * start entry to fill it in; a file that names it is a file that can call it,
 * and that is how the second admission path appeared in the first place.
 */

import { randomUUID } from 'node:crypto';
import type {
  HostSessionInputApiV1,
  SessionControlHolderKind,
  SessionControlLease,
  SessionControlLeaseRequest,
  SessionInputActor,
  SessionInputActorKind,
  SessionInputReceipt,
  SessionInputRequest,
} from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { SessionControlLeaseRecord, SessionInputRecord } from '@duya/data';

/**
 * What the Host did with an accepted input.
 *
 * The three states are the ones a caller can act on: it reached a run, it is
 * held for later, or it was refused and here is why.
 */
export type SessionInputDelivery =
  | { readonly state: 'delivered'; readonly runId?: string; readonly turnId?: string }
  | { readonly state: 'queued' }
  | { readonly state: 'rejected'; readonly reason: string };

/**
 * How an accepted input reaches the session.
 *
 * The Host assembles this; the service never decides how a turn starts.
 */
export interface SessionInputDeliveryPort {
  deliver(input: SessionInputRequest): Promise<SessionInputDelivery>;
}

/** The actor a lease can be held by. */
const HOLDER_KINDS: readonly SessionControlHolderKind[] = ['user', 'bot', 'plugin'];

/** A lease longer than this is shortened by the Host, not honoured. */
const DEFAULT_MAX_LEASE_TTL_MS = 15 * 60_000;
/** The lifetime used when the caller does not ask for one. */
const DEFAULT_LEASE_TTL_MS = 60_000;

export interface HostSessionInputApiOptions {
  readonly stores: Pick<CoreDataHostStores, 'sessionInputs' | 'sessionControlLeases'>;
  /**
   * Who this service speaks for.
   *
   * Derived by the Host when it assembles the service. It is never read from
   * a request: the whole point of the lease is that the Host decides who may
   * direct a session, and an actor a caller chose would make that decision
   * the caller's.
   */
  readonly actor: SessionInputActor;
  /**
   * Where accepted inputs go.
   *
   * Absent means the input is recorded and left alone: the receipt says
   * `persisted`, which is the honest stage for "durably recorded, not handed
   * to anything yet".
   */
  readonly delivery?: SessionInputDeliveryPort | undefined;
  readonly now?: () => number;
  readonly maxLeaseTtlMs?: number | undefined;
  readonly defaultLeaseTtlMs?: number | undefined;
}

/**
 * Assemble the Session input service.
 *
 * The service holds no state of its own. Everything durable lives in the two
 * stores, so two Host processes reading the same database see the same
 * receipts and the same leases — a service that cached either would be a
 * second authority the first time a Host and the cache disagreed.
 */
export function createHostSessionInputApi(
  options: HostSessionInputApiOptions,
): HostSessionInputApiV1 {
  const { sessionInputs, sessionControlLeases } = options.stores;
  const now = options.now ?? (() => Date.now());
  const maxLeaseTtlMs = options.maxLeaseTtlMs ?? DEFAULT_MAX_LEASE_TTL_MS;
  const defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  function holderKindFor(actorKind: SessionInputActorKind): SessionControlHolderKind | null {
    return HOLDER_KINDS.includes(actorKind as SessionControlHolderKind)
      ? (actorKind as SessionControlHolderKind)
      : null;
  }

  function toReceipt(record: SessionInputRecord): SessionInputReceipt {
    return {
      inputId: record.inputId,
      requestId: record.requestId,
      sessionId: record.sessionId,
      actor: {
        kind: record.actorKind,
        ...(record.actorId === null ? {} : { id: record.actorId }),
      },
      stage: record.stage,
      ...(record.reason === null ? {} : { reason: record.reason }),
      ...(record.runId === null ? {} : { runId: record.runId }),
      ...(record.turnId === null ? {} : { turnId: record.turnId }),
    };
  }

  function toLease(record: SessionControlLeaseRecord): SessionControlLease {
    return {
      sessionId: record.sessionId,
      leaseId: record.leaseId,
      holder: { kind: record.holderKind, id: record.holderId },
      revision: record.revision,
      requestId: record.requestId,
      expiresAt: record.expiresAtMs,
    };
  }

  /**
   * Whether the current lease stops THIS actor from directing the session.
   *
   * A lease that nobody holds stops nobody. A lease this actor holds stops
   * nobody either — the holder is the one who may keep going. Only a lease
   * held by SOMEONE ELSE stops the input, and it stops it with a recorded
   * reason rather than a silence.
   */
  function blockedByLease(sessionId: string): string | null {
    const lease = sessionControlLeases.read(sessionId, now());
    if (lease === null) return null;
    const holderKind = holderKindFor(options.actor.kind);
    if (holderKind === null) return 'control_lease_held';
    if (lease.holderKind !== holderKind) return 'control_lease_held';
    return lease.holderId === (options.actor.id ?? 'local') ? null : 'control_lease_held';
  }

  return {
    async submitInput(request: SessionInputRequest): Promise<SessionInputReceipt> {
      const sessionId = requireText(request.sessionId, 'sessionId');
      const requestId = requireText(request.requestId, 'requestId');
      if (typeof request.content !== 'string') {
        throw new HostSessionInputApiError('invalid_input', 'content must be a string');
      }
      if (!isIntent(request.intent)) {
        throw new HostSessionInputApiError('invalid_input', `unknown intent: ${String(request.intent)}`);
      }

      // The record comes first. A caller that loses the response has to be
      // able to ask again and get the SAME answer, and it can only do that if
      // the answer was written down before it was sent.
      const record = sessionInputs.accept({
        inputId: randomUUID(),
        sessionId,
        requestId,
        intent: request.intent,
        actorKind: options.actor.kind,
        ...(options.actor.id === undefined ? {} : { actorId: options.actor.id }),
      });
      // A retry of an input that already moved on returns that record. The
      // receipt is the same one the first caller got.
      if (record.stage !== 'persisted') return toReceipt(record);

      const delivery = options.delivery;
      if (!delivery) return toReceipt(record);

      // Exactly one caller delivers a shared record. The claim is a
      // conditional update, so a concurrent retry loses it and waits for the
      // winner's receipt instead of producing a second run.
      if (!sessionInputs.claimPending(sessionId, requestId)) {
        const current = sessionInputs.get(sessionId, requestId);
        return current === null ? toReceipt(record) : toReceipt(current);
      }

      const blocked = blockedByLease(sessionId);
      if (blocked !== null) {
        sessionInputs.advanceStage(sessionId, requestId, 'rejected', { reason: blocked });
        const rejected = sessionInputs.get(sessionId, requestId);
        return rejected === null ? toReceipt(record) : toReceipt(rejected);
      }

      let outcome: SessionInputDelivery;
      try {
        outcome = await delivery.deliver(request);
      } catch (error) {
        sessionInputs.advanceStage(sessionId, requestId, 'rejected', {
          reason: error instanceof Error ? error.message : String(error),
        });
        const rejected = sessionInputs.get(sessionId, requestId);
        return rejected === null ? toReceipt(record) : toReceipt(rejected);
      }

      if (outcome.state === 'delivered') {
        sessionInputs.advanceStage(sessionId, requestId, 'delivered', {
          ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
          ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
        });
      } else if (outcome.state === 'queued') {
        sessionInputs.advanceStage(sessionId, requestId, 'queued');
      } else {
        sessionInputs.advanceStage(sessionId, requestId, 'rejected', { reason: outcome.reason });
      }
      const settled = sessionInputs.get(sessionId, requestId);
      return settled === null ? toReceipt(record) : toReceipt(settled);
    },

    async readInputReceipt(sessionId: string, requestId: string): Promise<SessionInputReceipt | null> {
      const record = sessionInputs.get(sessionId, requestId);
      return record === null ? null : toReceipt(record);
    },

    async acquireControlLease(
      request: SessionControlLeaseRequest,
    ): Promise<SessionControlLease | null> {
      const sessionId = requireText(request.sessionId, 'sessionId');
      const requestId = requireText(request.requestId, 'requestId');
      const holderKind = holderKindFor(options.actor.kind);
      // A channel or a system actor is not a holder. Letting it take a lease
      // would put a session under the control of something that has no stable
      // id to release it with.
      if (holderKind === null) return null;

      const ttlMs = Math.min(
        Math.max(1, request.ttlMs ?? defaultLeaseTtlMs),
        maxLeaseTtlMs,
      );
      const lease = sessionControlLeases.acquire({
        sessionId,
        leaseId: randomUUID(),
        holderKind,
        holderId: options.actor.id ?? 'local',
        requestId,
        ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
        ttlMs,
        nowMs: now(),
      });
      return lease === null ? null : toLease(lease);
    },

    async releaseControlLease(sessionId: string, revision: number): Promise<boolean> {
      return sessionControlLeases.release(sessionId, revision, now());
    },

    async readControlLease(sessionId: string): Promise<SessionControlLease | null> {
      const lease = sessionControlLeases.read(sessionId, now());
      return lease === null ? null : toLease(lease);
    },
  };
}

/** Why an input could not be accepted at all. */
export type HostSessionInputApiErrorCode = 'invalid_input';

export class HostSessionInputApiError extends Error {
  constructor(
    readonly code: HostSessionInputApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostSessionInputApiError';
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HostSessionInputApiError('invalid_input', `${field} is required`);
  }
  return value;
}

function isIntent(value: unknown): value is SessionInputRequest['intent'] {
  return value === 'steer' || value === 'enqueue' || value === 'interrupt';
}
