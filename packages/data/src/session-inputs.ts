/**
 * session-inputs.ts — durable Session inputs and the per-session control
 * lease (R1.2).
 *
 * ## Why these two tables exist
 *
 * The product had three input paths and none of them spoke the same
 * language. A user turn, a TUI steer and a Bot dispatch each carried their
 * own idempotency key, their own ordering and their own receipt, and there
 * was no single place that could answer "was this input accepted, and where
 * is it now?".
 *
 * `session_inputs` is that place. It is deliberately NOT a second
 * transcript: it records the INPUT — who sent it, what it asked for, and
 * how far it got — and the content itself still travels on the carriers the
 * product already has (a mailbox row for a steer, a run for a turn).
 *
 * `session_control_leases` records who may direct a session at all.
 *
 * ## The dedup key is `(session_id, request_id)`
 *
 * `requestId` is the caller's idempotency key, and it is scoped to the
 * session: two different sessions may legitimately use the same id, and
 * `readInputReceipt(sessionId, requestId)` is itself per-session. A global
 * key would make one session's request refuse another's.
 *
 * ## The lease is a REVISION CAS, not a flag
 *
 * Granting bumps `revision`. A holder proves it still holds the lease by
 * presenting the revision it was given, and the Host checks that revision
 * atomically before dispatching anything. A boolean "is a lease held"
 * cannot answer the question that matters — "is THIS holder still the one
 * that was granted" — and that question is what makes a takeover safe: the
 * previous holder's in-flight instruction fails the check instead of racing
 * the new holder.
 *
 * ## The lease is NOT the worker execution fence
 *
 * `RunAttemptFence` rejects stale ATTEMPTS of one run; this decides who may
 * start the next instruction. They are separate facts with separate
 * authorities, and the product already has three similar-looking epoch
 * counters. Keeping this one in its own table is the point.
 */

import type { Migration, SqliteDatabase } from './core-database.js';

/** Mirrors the protocol's intent vocabulary. */
export type SessionInputIntent = 'steer' | 'enqueue' | 'interrupt';
/** Mirrors the protocol's stage vocabulary. */
export type SessionInputStage = 'persisted' | 'queued' | 'delivered' | 'consumed' | 'rejected';
/** Mirrors the protocol's actor vocabulary. */
export type SessionInputActorKind = 'user' | 'bot' | 'plugin' | 'channel' | 'system';
/** Mirrors the protocol's lease-holder vocabulary. */
export type SessionControlHolderKind = 'user' | 'bot' | 'plugin';

export interface SessionInputRecord {
  /** Host-minted id of the durable record. */
  readonly inputId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly intent: SessionInputIntent;
  readonly stage: SessionInputStage;
  readonly reason: string | null;
  readonly actorKind: SessionInputActorKind;
  readonly actorId: string | null;
  /** Monotonic per session. The order inputs arrived in. */
  readonly inputSeq: number;
  readonly runId: string | null;
  readonly turnId: string | null;
  readonly createdMs: number;
  readonly updatedMs: number;
}

export interface PersistSessionInputInput {
  readonly inputId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly intent: SessionInputIntent;
  readonly actorKind: SessionInputActorKind;
  readonly actorId?: string | undefined;
  readonly stage?: SessionInputStage;
  readonly reason?: string | undefined;
  readonly runId?: string | undefined;
  readonly turnId?: string | undefined;
}

export interface SessionControlLeaseRecord {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly holderKind: SessionControlHolderKind;
  readonly holderId: string;
  readonly revision: number;
  readonly requestId: string;
  readonly expiresAtMs: number;
  readonly updatedMs: number;
}

export const SESSION_INPUT_MIGRATIONS: readonly Migration[] = [
  {
    id: 49,
    name: 'create_session_inputs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_inputs (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          request_id  TEXT NOT NULL,
          intent      TEXT NOT NULL
                      CHECK (intent IN ('steer','enqueue','interrupt')),
          stage       TEXT NOT NULL
                      CHECK (stage IN ('persisted','queued','delivered','consumed','rejected')),
          reason      TEXT,
          actor_kind  TEXT NOT NULL
                      CHECK (actor_kind IN ('user','bot','plugin','channel','system')),
          actor_id    TEXT,
          input_seq   INTEGER NOT NULL,
          run_id      TEXT,
          turn_id     TEXT,
          created_ms  INTEGER NOT NULL,
          updated_ms  INTEGER NOT NULL,
          UNIQUE (session_id, request_id),
          UNIQUE (session_id, input_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_session_inputs_session
          ON session_inputs(session_id, input_seq);
      `);
    },
  },
];

export const SESSION_CONTROL_LEASE_MIGRATIONS: readonly Migration[] = [
  {
    id: 50,
    name: 'create_session_control_leases',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_control_leases (
          session_id    TEXT PRIMARY KEY,
          lease_id      TEXT NOT NULL,
          holder_kind   TEXT NOT NULL
                        CHECK (holder_kind IN ('user','bot','plugin')),
          holder_id     TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          request_id    TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          updated_ms    INTEGER NOT NULL
        );
      `);
    },
  },
];

interface SessionInputRow {
  id: string;
  session_id: string;
  request_id: string;
  intent: string;
  stage: string;
  reason: string | null;
  actor_kind: string;
  actor_id: string | null;
  input_seq: number;
  run_id: string | null;
  turn_id: string | null;
  created_ms: number;
  updated_ms: number;
}

interface SessionControlLeaseRow {
  session_id: string;
  lease_id: string;
  holder_kind: string;
  holder_id: string;
  revision: number;
  request_id: string;
  expires_at_ms: number;
  updated_ms: number;
}

function rowToInput(row: SessionInputRow): SessionInputRecord {
  return {
    inputId: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    intent: row.intent as SessionInputIntent,
    stage: row.stage as SessionInputStage,
    reason: row.reason,
    actorKind: row.actor_kind as SessionInputActorKind,
    actorId: row.actor_id,
    inputSeq: row.input_seq,
    runId: row.run_id,
    turnId: row.turn_id,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

function rowToLease(row: SessionControlLeaseRow): SessionControlLeaseRecord {
  return {
    sessionId: row.session_id,
    leaseId: row.lease_id,
    holderKind: row.holder_kind as SessionControlHolderKind,
    holderId: row.holder_id,
    revision: row.revision,
    requestId: row.request_id,
    expiresAtMs: row.expires_at_ms,
    updatedMs: row.updated_ms,
  };
}

/**
 * The durable record of every input a session accepted.
 *
 * ## Why the insert is a CONFLICT-and-read
 *
 * The dedup has to be ATOMIC: two concurrent submits with the same
 * `requestId` must produce one input, not two and not an error. `INSERT …
 * ON CONFLICT DO NOTHING` followed by a read of the existing row is that:
 * the second submit finds the first one's row and returns it.
 */
export class SessionInputStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Record an input, or return the one that already holds this request id.
   *
   * The returned record's `inputSeq` is the per-session order. It is
   * allocated inside the same transaction as the insert, so two inputs can
   * never claim the same slot.
   */
  accept(input: PersistSessionInputInput): SessionInputRecord {
    const now = Date.now();
    const accept = this.db.transaction(() => {
      const existing = this.get(input.sessionId, input.requestId);
      if (existing !== null) return existing;
      // The insert may lose a race on EITHER unique key, so the retry has to
      // tell the two apart: a lost request id means another submit already
      // owns this input (return ITS record), a lost slot means the ordering
      // moved under us (take the next slot and try again).
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const seqRow = this.db
          .prepare('SELECT COALESCE(MAX(input_seq), 0) + 1 AS next FROM session_inputs WHERE session_id = ?')
          .get(input.sessionId) as unknown as { next: number };
        const result = this.db
          .prepare(
            `INSERT INTO session_inputs
               (id, session_id, request_id, intent, stage, reason, actor_kind, actor_id,
                input_seq, run_id, turn_id, created_ms, updated_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .run(
            input.inputId,
            input.sessionId,
            input.requestId,
            input.intent,
            input.stage ?? 'persisted',
            input.reason ?? null,
            input.actorKind,
            input.actorId ?? null,
            seqRow.next,
            input.runId ?? null,
            input.turnId ?? null,
            now,
            now,
          );
        const record = this.get(input.sessionId, input.requestId);
        if (record !== null) return record;
        if (result.changes > 0) continue;
      }
      return null;
    });
    const record = accept();
    if (record === null) {
      throw new Error(`session input ${input.inputId} was accepted but could not be read back`);
    }
    return record;
  }

  /** The input this request id produced, or null. */
  get(sessionId: string, requestId: string): SessionInputRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, request_id, intent, stage, reason, actor_kind, actor_id,
                input_seq, run_id, turn_id, created_ms, updated_ms
         FROM session_inputs WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as unknown as SessionInputRow | undefined;
    return row === undefined ? null : rowToInput(row);
  }

  /**
   * Take the pending input for delivery, or report that someone else has it.
   *
   * ## Why this is a CONDITIONAL update
   *
   * Two callers can submit the same `requestId` at the same time. The dedup
   * makes them share ONE record, so something has to stop them from both
   * delivering it — otherwise one instruction becomes two runs. The stage
   * moves from `persisted` to `queued` exactly once, and the caller whose
   * UPDATE changed a row is the one that delivers.
   *
   * The conditional is the whole primitive. A read-then-write would let two
   * callers both read `persisted` and both write.
   */
  claimPending(sessionId: string, requestId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE session_inputs
            SET stage = 'queued', updated_ms = ?
          WHERE session_id = ? AND request_id = ? AND stage = 'persisted'`,
      )
      .run(Date.now(), sessionId, requestId);
    return result.changes > 0;
  }

  /** Move an input to a new stage. Returns false when the input is gone. */
  advanceStage(
    sessionId: string,
    requestId: string,
    stage: SessionInputStage,
    extra?: { readonly reason?: string | undefined; readonly runId?: string | undefined; readonly turnId?: string | undefined },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE session_inputs
            SET stage = ?,
                reason = COALESCE(?, reason),
                run_id = COALESCE(?, run_id),
                turn_id = COALESCE(?, turn_id),
                updated_ms = ?
          WHERE session_id = ? AND request_id = ?`,
      )
      .run(
        stage,
        extra?.reason ?? null,
        extra?.runId ?? null,
        extra?.turnId ?? null,
        Date.now(),
        sessionId,
        requestId,
      );
    return result.changes > 0;
  }

  /** The session's inputs, in the order they arrived. */
  listForSession(sessionId: string): SessionInputRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, request_id, intent, stage, reason, actor_kind, actor_id,
                input_seq, run_id, turn_id, created_ms, updated_ms
         FROM session_inputs WHERE session_id = ? ORDER BY input_seq ASC`,
      )
      .all(sessionId) as unknown as SessionInputRow[];
    return rows.map(rowToInput);
  }
}

/**
 * The lease that says who may direct a session.
 *
 * ## Why the grant is a CAS
 *
 * A grant bumps `revision`. A caller that expected a specific revision and
 * did not get it is refused, so a takeover cannot silently happen under a
 * holder that still believes it holds the lease.
 */
export class SessionControlLeaseStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Take the lease for a session, or fail.
   *
   * `expectedRevision` is the revision the caller believes is current.
   * Present means "I am extending MY lease"; absent means "I am asking for
   * the session to myself", which bumps the revision and invalidates the
   * previous holder.
   */
  acquire(input: {
    readonly sessionId: string;
    readonly leaseId: string;
    readonly holderKind: SessionControlHolderKind;
    readonly holderId: string;
    readonly requestId: string;
    readonly expectedRevision?: number | undefined;
    readonly ttlMs: number;
    readonly nowMs?: number | undefined;
  }): SessionControlLeaseRecord | null {
    const now = input.nowMs ?? Date.now();
    const acquire = this.db.transaction(() => {
      const stored = this.#readStoredRow(input.sessionId);
      // Rights and history are two different reads. An expired lease grants no
      // rights, but its revision still counts.
      const current = stored !== null && stored.expires_at_ms > now ? stored : null;
      if (input.expectedRevision !== undefined) {
        // The caller believes a specific revision is current. If that is not
        // what is stored, someone else moved first and this grant is refused.
        if (current === null || current.revision !== input.expectedRevision) return null;
      }
      // The revision keeps counting across an expiry. Restarting the count at
      // one would let a holder that lost the lease present the number it
      // remembers and be believed — the ABA case the CAS exists to stop.
      const revision = (stored?.revision ?? 0) + 1;
      const expiresAt = now + Math.max(1, input.ttlMs);
      if (stored === null) {
        this.db
          .prepare(
            `INSERT INTO session_control_leases
               (session_id, lease_id, holder_kind, holder_id, revision, request_id, expires_at_ms, updated_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.sessionId, input.leaseId, input.holderKind, input.holderId, revision, input.requestId, expiresAt, now);
      }
      else {
        this.db
          .prepare(
            `UPDATE session_control_leases
                SET lease_id = ?, holder_kind = ?, holder_id = ?, revision = ?,
                    request_id = ?, expires_at_ms = ?, updated_ms = ?
              WHERE session_id = ?`,
          )
          .run(input.leaseId, input.holderKind, input.holderId, revision, input.requestId, expiresAt, now, input.sessionId);
      }
      return this.#readStoredRow(input.sessionId);
    });
    const lease = acquire();
    return lease === null ? null : rowToLease(lease);
  }

  /**
   * Give the lease back.
   *
   * The holder must present its revision: a caller that lost the lease to a
   * takeover cannot release the new holder's lease.
   */
  release(sessionId: string, revision: number, nowMs?: number): boolean {
    const release = this.db.transaction(() => {
      // The release compares against the STORED revision, not the live one:
      // giving back a lease that already expired is harmless, and refusing it
      // would leave a dead row behind.
      const stored = this.#readStoredRow(sessionId);
      if (stored === null) return false;
      if (stored.revision !== revision) return false;
      this.db.prepare('DELETE FROM session_control_leases WHERE session_id = ?').run(sessionId);
      return true;
    });
    return release();
  }

  /** The lease that currently grants rights, or null. An expired lease grants none. */
  read(sessionId: string, nowMs?: number): SessionControlLeaseRecord | null {
    const row = this.#readLiveRow(sessionId, nowMs ?? Date.now());
    return row === null ? null : rowToLease(row);
  }

  /**
   * The lease row, EXPIRED or not.
   *
   * The expiry is applied by the READERS, not by a sweep: an expired lease
   * grants no rights, and a lease that is never swept still stops granting
   * rights the moment it expires.
   */
  #readLiveRow(sessionId: string, nowMs: number): SessionControlLeaseRow | null {
    const row = this.#readStoredRow(sessionId);
    if (row === null) return null;
    if (row.expires_at_ms <= nowMs) return null;
    return row;
  }

  /** The lease row as stored, whether or not it has expired. */
  #readStoredRow(sessionId: string): SessionControlLeaseRow | null {
    const row = this.db
      .prepare(
        `SELECT session_id, lease_id, holder_kind, holder_id, revision, request_id, expires_at_ms, updated_ms
           FROM session_control_leases WHERE session_id = ?`,
      )
      .get(sessionId) as unknown as SessionControlLeaseRow | undefined;
    return row === undefined ? null : row;
  }
}
