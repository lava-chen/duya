/**
 * bot-inbox.ts — durable Bot inbox and dispatch receipts (framework plan S3a).
 *
 * ## Why this store exists
 *
 * The personal-agent framework plan (docs/exec-plans/active/
 * 2026-10-25-personal-bot-framework.md, slice S3a; contract in
 * docs/design-docs/personal-bot-framework.md §6 and §10) moves Bot input
 * scheduling off Desktop-main memory onto a durable queue. `pending_wakes`
 * records only a *wake intent* — `(kind, work_id)` and a label, no payload,
 * no owner/bot scope, no dispatch binding. The inbox records the ACCEPTED
 * INPUT itself: its payload (or a reconstructable reference), its attempt
 * count, its dispatch key, and its full lifecycle
 * `pending → claimed → dispatched → settled | dead_letter`. S3b wires the
 * Host dispatcher on top of this contract; nothing in this file schedules.
 *
 * Both tables live in the core database's transaction domain
 * (`createCoreDataStores`), as §10 directs: "新 inbox / dispatch receipt
 * 优先加入该事务域".
 *
 * ## Dedup key
 *
 * `owner\0bot\0source\0binding\0sourceEventId`, composed HERE, not by
 * callers — a dedup key that callers assemble is a dedup key callers can
 * assemble two ways. A channel redelivery therefore cannot overwrite another
 * bot's input (§6 invariant 1). Legacy rows keep their weaker
 * `legacy\0kind\0work_id` shape: two NUL separators versus the five-part
 * key's four, so the two shapes can never collide.
 *
 * ## Dispatch receipts and the reserve three-state
 *
 * `reserve` is the idempotent seam S3b's run acceptance builds on (§6
 * invariant 4): a dispatch key binds to exactly one run id, ever. The first
 * reserve wins with `fresh`; every later reserve — a retry whose first
 * response was lost — gets the ORIGINAL run id back and must discard its own
 * candidate. `recordDispatch` then lands the input `claimed → dispatched`
 * and the receipt `reserved → opened` in ONE transaction. A receipt already
 * bound to a different run id is a hard conflict: it is reported, never
 * overwritten.
 *
 * ## Lease semantics
 *
 * `claim` is a CAS `pending → claimed` ordered `user > agent > background`,
 * then oldest first — the wake scheduler's existing precedence (§6). The
 * lease writes `lease_owner`, a self-incrementing `lease_epoch` (the row's
 * fencing token) and `deadline_ms`. `requeueExpired` is deliberately
 * MECHANICAL (only expired `claimed` rows go back to `pending`, attempt + 1,
 * lease grant cleared): lease expiry never auto-proves a rerun — recovery is
 * S3b's job, consulting receipts first (§6). The epoch is deliberately NOT
 * reset by a requeue: a fencing token that restarts at 1 every cycle cannot
 * tell a holder from the previous cycle away from the current one, which is
 * the exact confusion a fence exists to prevent. The row's monotonic retry
 * counter is `attempt`.
 *
 * ## Migration id 45
 *
 * Core migration ids run in one sequence across `collectCoreDataMigrations()`
 * (see `core-data-host.ts`); the highest core id in this package before this
 * file was 44 (`integration-store.ts`), so 45 is measured, not guessed — the
 * `id <= current` guard in `runMigrations` silently skips a colliding id,
 * which is how `session_runtime_locks.origin` was once lost (see the
 * `LockStore` id-17 note in `core-stores.ts`). `main-schema.ts` numbers reach
 * past 45 but belong to the SEPARATE main database; the two sequences are
 * independent (same note on `plugin-app-instance-store.ts`, id 40).
 *
 * ## Legacy import
 *
 * `importLegacyPendingWakes` maps old `pending_wakes` markers into the inbox
 * additively (§10): source `legacy`, dedup key `legacy\0kind\0work_id`, and
 * a payload that records only the facts the marker actually carried. The old
 * key predates owner/bot/source/binding scoping and carries NO message
 * payload, so an imported row is a review obligation, never a fabricated
 * user message; rows that cannot even form a stable identity are reported as
 * `notReconstructible`. A dedup collision is reported as `conflict` and the
 * stored row is never overwritten. Dry-run writes nothing.
 */

import { randomUUID } from 'node:crypto';
import type {
  BotDispatchState,
  BotInboxLane,
  BotInboxStatus,
} from '@duya/agent-protocol/bot-inbox-api';
export type {
  BotDispatchState,
  BotInboxLane,
  BotInboxStatus,
} from '@duya/agent-protocol/bot-inbox-api';
import type { Migration, SqliteDatabase } from './core-database.js';
import type { PendingWakeRow } from './pending-wakes.js';

/** Field separator of the composed dedup key. Never escaped: ids may not contain NUL. */
export const BOT_INBOX_DEDUP_SEPARATOR = '\0';

/** One accepted input, as stored and read back. */
export interface BotInboxEntry {
  id: string;
  ownerId: string;
  botId: string;
  source: string;
  sourceEventId: string;
  bindingId: string | null;
  dedupKey: string;
  status: BotInboxStatus;
  payloadJson: string | null;
  attempt: number;
  dispatchKey: string | null;
  lane: BotInboxLane;
  title: string | null;
  leaseOwner: string | null;
  leaseEpoch: number | null;
  deadlineMs: number | null;
  /** Why the input was dead-lettered; null on every other row. */
  deadLetterReason: string | null;
  createdAtMs: number;
  claimedAtMs: number | null;
  dispatchedAtMs: number | null;
  settledAtMs: number | null;
}

/** One dispatch receipt, as stored and read back. */
export interface BotDispatchReceiptRow {
  dispatchKey: string;
  runId: string;
  /** The inbox input this receipt was landed for, when it has one yet. */
  botInboxId: string | null;
  state: BotDispatchState;
  acceptedAtMs: number;
}

export interface BotInboxAcceptInput {
  ownerId: string;
  botId: string;
  source: string;
  sourceEventId: string;
  bindingId?: string | null | undefined;
  lane?: BotInboxLane | undefined;
  payloadJson?: string | null | undefined;
  title?: string | null | undefined;
}

export interface BotInboxAcceptResult {
  entry: BotInboxEntry;
  /** True when the input had already been accepted; the existing row is returned. */
  deduplicated: boolean;
}

export interface BotInboxClaimGrant {
  entry: BotInboxEntry;
  leaseOwner: string;
  leaseEpoch: number;
  deadlineMs: number;
}

export type BotDispatchReserveOutcome =
  | { state: 'fresh'; runId: string; receipt: BotDispatchReceiptRow }
  | { state: 'reserved'; runId: string; receipt: BotDispatchReceiptRow }
  | { state: 'opened'; runId: string; receipt: BotDispatchReceiptRow };

export type BotInboxDispatchOutcome =
  /** The CAS won: input `claimed → dispatched`, receipt landed or opened. */
  | { state: 'applied'; entry: BotInboxEntry; receipt: BotDispatchReceiptRow }
  | {
      state: 'replayed';
      entry: BotInboxEntry;
      receipt: BotDispatchReceiptRow;
    }
  /** The input exists but is not in a claimable-for-dispatch state. No write. */
  | { state: 'not_claimed'; entry: BotInboxEntry }
  | { state: 'absent' };

export type BotInboxSettleOutcome =
  | { state: 'applied'; entry: BotInboxEntry }
  | { state: 'replayed'; entry: BotInboxEntry }
  | { state: 'not_dispatched'; entry: BotInboxEntry }
  | { state: 'absent' };

export type BotInboxDeadLetterOutcome =
  | { state: 'applied'; entry: BotInboxEntry }
  /** Already dead-lettered: the FIRST reason is kept, never overwritten. */
  | { state: 'replayed'; entry: BotInboxEntry }
  | { state: 'already_settled'; entry: BotInboxEntry }
  | { state: 'absent' };

export interface BotInboxLegacyImportReport {
  /** Rows inserted as pending `legacy` inbox entries. */
  imported: number;
  /** Rows whose dedup key already exists; the stored row is never overwritten. */
  conflicts: number;
  /** Rows that cannot form a stable identity (blank kind or work id). */
  notReconstructible: number;
}

/**
 * A dispatch key is already bound to a DIFFERENT run id.
 *
 * Its own class because it is never retryable: re-offering the same pair
 * fails identically every time, and the stored binding is the one S3b must
 * dispatch. Thrown, not returned, because a caller that receives a receipt
 * for someone else's run must stop and reconcile (§6 invariant 5), not
 * continue with a success shape.
 */
export class BotInboxDispatchConflictError extends Error {
  readonly code = 'dispatch_run_conflict' as const;

  constructor(
    readonly dispatchKey: string,
    readonly storedRunId: string,
    readonly offeredRunId: string,
  ) {
    super(
      `dispatch key "${dispatchKey}" is already bound to run "${storedRunId}"; refusing to rebind it to "${offeredRunId}"`,
    );
    this.name = 'BotInboxDispatchConflictError';
  }
}

/** Compose the five-part dedup key. Binding absence is the empty part. */
export function composeBotInboxDedupKey(
  ownerId: string,
  botId: string,
  source: string,
  bindingId: string | null,
  sourceEventId: string,
): string {
  return [ownerId, botId, source, bindingId ?? '', sourceEventId].join(
    BOT_INBOX_DEDUP_SEPARATOR,
  );
}

/** The legacy marker's weaker key: kind + work id, two separators, no scope. */
export function composeLegacyDedupKey(kind: string, workId: string): string {
  return ['legacy', kind, workId].join(BOT_INBOX_DEDUP_SEPARATOR);
}

export const BOT_INBOX_MIGRATIONS: readonly Migration[] = [
  {
    id: 45,
    name: 'create_bot_inbox',
    up: (db) => {
      // `dedup_key` carries its uniqueness as a column constraint: that IS the
      // unique index the contract asks for, and a second named UNIQUE index on
      // the same column would only double every write's index maintenance.
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_inbox (
          id                  TEXT PRIMARY KEY,
          owner_id            TEXT NOT NULL,
          bot_id              TEXT NOT NULL,
          source              TEXT NOT NULL,
          source_event_id     TEXT NOT NULL,
          binding_id          TEXT,
          dedup_key           TEXT NOT NULL UNIQUE,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','claimed','dispatched','settled','dead_letter')),
          payload_json        TEXT,
          attempt             INTEGER NOT NULL DEFAULT 0,
          dispatch_key        TEXT,
          lane                TEXT NOT NULL DEFAULT 'background'
                              CHECK (lane IN ('user','agent','background')),
          title               TEXT,
          lease_owner         TEXT,
          lease_epoch         INTEGER,
          deadline_ms         INTEGER,
          dead_letter_reason  TEXT,
          created_ms          INTEGER NOT NULL,
          claimed_at_ms       INTEGER,
          dispatched_at_ms    INTEGER,
          settled_at_ms       INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_bot_inbox_bot ON bot_inbox(bot_id, status, lane);
        CREATE INDEX IF NOT EXISTS idx_bot_inbox_deadline ON bot_inbox(deadline_ms);

        CREATE TABLE IF NOT EXISTS bot_dispatch_receipts (
          dispatch_key    TEXT PRIMARY KEY,
          run_id          TEXT NOT NULL,
          bot_inbox_id    TEXT,
          state           TEXT NOT NULL DEFAULT 'reserved'
                          CHECK (state IN ('reserved','opened')),
          accepted_at_ms  INTEGER NOT NULL
        );
      `);
    },
  },
];

interface BotInboxDbRow {
  id: string;
  owner_id: string;
  bot_id: string;
  source: string;
  source_event_id: string;
  binding_id: string | null;
  dedup_key: string;
  status: string;
  payload_json: string | null;
  attempt: number;
  dispatch_key: string | null;
  lane: string;
  title: string | null;
  lease_owner: string | null;
  lease_epoch: number | null;
  deadline_ms: number | null;
  dead_letter_reason: string | null;
  created_ms: number;
  claimed_at_ms: number | null;
  dispatched_at_ms: number | null;
  settled_at_ms: number | null;
}

interface BotDispatchReceiptDbRow {
  dispatch_key: string;
  run_id: string;
  bot_inbox_id: string | null;
  state: string;
  accepted_at_ms: number;
}

function rowToEntry(row: BotInboxDbRow): BotInboxEntry {
  return {
    id: row.id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    bindingId: row.binding_id,
    dedupKey: row.dedup_key,
    status: row.status as BotInboxStatus,
    payloadJson: row.payload_json,
    attempt: row.attempt,
    dispatchKey: row.dispatch_key,
    lane: row.lane as BotInboxLane,
    title: row.title,
    leaseOwner: row.lease_owner,
    leaseEpoch: row.lease_epoch,
    deadlineMs: row.deadline_ms,
    deadLetterReason: row.dead_letter_reason,
    createdAtMs: row.created_ms,
    claimedAtMs: row.claimed_at_ms,
    dispatchedAtMs: row.dispatched_at_ms,
    settledAtMs: row.settled_at_ms,
  };
}

function rowToReceipt(row: BotDispatchReceiptDbRow): BotDispatchReceiptRow {
  return {
    dispatchKey: row.dispatch_key,
    runId: row.run_id,
    botInboxId: row.bot_inbox_id,
    state: row.state as BotDispatchState,
    acceptedAtMs: row.accepted_at_ms,
  };
}

export class BotInboxStore {
  /** The migrations, as the static every other aggregate exposes. */
  static readonly migrations: Migration[] = [...BOT_INBOX_MIGRATIONS];

  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Accept one verified input. Idempotent by the composed dedup key: a row
   * already holding it is returned unchanged with `deduplicated: true`, and
   * no second acceptance identity is created. The result is built after the
   * transaction commits — an acceptance that later rolls back can never be
   * observed (§6 invariant 2).
   */
  accept(input: BotInboxAcceptInput): BotInboxAcceptResult {
    const dedupKey = composeBotInboxDedupKey(
      input.ownerId,
      input.botId,
      input.source,
      input.bindingId ?? null,
      input.sourceEventId,
    );
    const id = randomUUID();
    const now = Date.now();
    const txn = this.db.transaction((): BotInboxAcceptResult => {
      const inserted = this.db
        .prepare(
          `INSERT INTO bot_inbox (
            id, owner_id, bot_id, source, source_event_id, binding_id,
            dedup_key, status, payload_json, attempt, lane, title, created_ms
          ) VALUES (
            @id, @owner_id, @bot_id, @source, @source_event_id, @binding_id,
            @dedup_key, 'pending', @payload_json, 0, @lane, @title, @created_ms
          )
          ON CONFLICT (dedup_key) DO NOTHING`,
        )
        .run({
          id,
          owner_id: input.ownerId,
          bot_id: input.botId,
          source: input.source,
          source_event_id: input.sourceEventId,
          binding_id: input.bindingId ?? null,
          dedup_key: dedupKey,
          payload_json: input.payloadJson ?? null,
          lane: input.lane ?? 'background',
          title: input.title ?? null,
          created_ms: now,
        });
      if (inserted.changes > 0) {
        const entry = this.getById(id);
        if (entry === null) {
          // Unreachable inside the same transaction: the INSERT above just
          // reported the row written. Thrown rather than answered with a
          // fabricated acceptance.
          throw new Error(`bot_inbox row ${id} vanished inside its own accept transaction`);
        }
        return { entry, deduplicated: false };
      }
      const existing = this.getByDedupKey(dedupKey);
      if (existing === null) {
        // Unreachable: the INSERT hit the dedup UNIQUE constraint, so the row
        // holding the key existed a statement ago. Honest error, not a
        // `deduplicated` verdict about a record nobody can find.
        throw new Error(`bot_inbox dedup race: key present for insert but absent on read-back`);
      }
      return { entry: existing, deduplicated: true };
    });
    return txn();
  }

  /**
   * Claim the next pending input for `botId`, CAS `pending → claimed`.
   *
   * Selection order is `user > agent > background`, then `created_ms`
   * ascending, then id — the wake scheduler's precedence. The lease writes
   * `leaseOwner`, bumps `lease_epoch` (a row claimed for the first time
   * starts at 1), and stamps `deadlineMs`. Returns null when the bot has no
   * pending input.
   */
  claim(botId: string, leaseOwner: string, deadlineMs: number): BotInboxClaimGrant | null {
    const now = Date.now();
    const txn = this.db.transaction((): BotInboxClaimGrant | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM bot_inbox
           WHERE bot_id = ? AND status = 'pending'
           ORDER BY CASE lane WHEN 'user' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END,
                    created_ms ASC, id ASC
           LIMIT 1`,
        )
        .get(botId) as BotInboxDbRow | undefined;
      if (row === undefined) return null;
      const updated = this.db
        .prepare(
          `UPDATE bot_inbox SET
             status = 'claimed',
             lease_owner = ?,
             lease_epoch = COALESCE(lease_epoch, 0) + 1,
             deadline_ms = ?,
             claimed_at_ms = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(leaseOwner, deadlineMs, now, row.id);
      if (updated.changes === 0) {
        // Unreachable inside the same transaction — the SELECT and the UPDATE
        // see the same snapshot. Return "nothing to claim" rather than invent
        // a grant.
        return null;
      }
      const entry = this.getById(row.id);
      if (entry === null) return null;
      return {
        entry,
        leaseOwner,
        leaseEpoch: entry.leaseEpoch ?? 1,
        deadlineMs,
      };
    });
    return txn();
  }

  /**
   * Reserve a dispatch key for a candidate run id (§6 invariant 4).
   *
   * First caller: the row is created `reserved` and `fresh` is answered with
   * that run id. Any later caller — including one whose first attempt
   * actually succeeded but whose response was lost — receives the STORED
   * binding (`reserved` or `opened`) with the ORIGINAL run id; the offered
   * candidate is discarded. Callers must dispatch the returned run id, never
   * their own.
   */
  reserve(dispatchKey: string, candidateRunId: string): BotDispatchReserveOutcome {
    const now = Date.now();
    const txn = this.db.transaction((): BotDispatchReserveOutcome => {
      const inserted = this.db
        .prepare(
          `INSERT INTO bot_dispatch_receipts (dispatch_key, run_id, bot_inbox_id, state, accepted_at_ms)
           VALUES (?, ?, NULL, 'reserved', ?)
           ON CONFLICT (dispatch_key) DO NOTHING`,
        )
        .run(dispatchKey, candidateRunId, now);
      if (inserted.changes > 0) {
        const receipt = this.readReceipt(dispatchKey);
        if (receipt === null) {
          throw new Error(`bot_dispatch_receipts row ${dispatchKey} vanished inside its own reserve transaction`);
        }
        return { state: 'fresh', runId: candidateRunId, receipt };
      }
      const existing = this.readReceipt(dispatchKey);
      if (existing === null) {
        // Unreachable: the INSERT conflicted on the primary key, so the row
        // exists. Thrown rather than fabricating a verdict.
        throw new Error(`bot_dispatch_receipts dedup race: key "${dispatchKey}" conflicted on insert but is absent on read`);
      }
      return { state: existing.state, runId: existing.runId, receipt: existing };
    });
    return txn();
  }

  /**
   * Record a dispatch: the input `claimed → dispatched` and its receipt
   * landed `opened`, in ONE transaction (§6 invariant 4).
   *
   * Receipt rules, checked before any write:
   *  - absent       → inserted `opened`, linked to this input.
   *  - same run id  → state forced to `opened`, `bot_inbox_id` backfilled
   *                   (COALESCE, so a link never moves) — idempotent.
   *  - other run id → {@link BotInboxDispatchConflictError}; nothing written.
   *
   * A second identical call is a `replayed` no-op. An input not in the
   * `claimed` state (or already holding a different dispatch key) answers
   * `not_claimed` and writes nothing.
   */
  recordDispatch(inboxId: string, dispatchKey: string, runId: string): BotInboxDispatchOutcome {
    const now = Date.now();
    const txn = this.db.transaction((): BotInboxDispatchOutcome => {
      const entry = this.getById(inboxId);
      if (entry === null) return { state: 'absent' };

      const receipt = this.readReceipt(dispatchKey);
      if (receipt !== null && receipt.runId !== runId) {
        throw new BotInboxDispatchConflictError(dispatchKey, receipt.runId, runId);
      }

      if (entry.status === 'dispatched') {
        // The input already went out. A replay only if it went out under THIS
        // key with THIS run; anything else is a second dispatch claim on a
        // decided input and is refused without writing.
        if (entry.dispatchKey === dispatchKey && receipt !== null && receipt.runId === runId) {
          const opened = this.openReceipt(dispatchKey, runId, inboxId, now);
          return { state: 'replayed', entry: this.getById(inboxId) ?? entry, receipt: opened };
        }
        return { state: 'not_claimed', entry };
      }
      if (entry.status !== 'claimed') return { state: 'not_claimed', entry };

      const updated = this.db
        .prepare(
          `UPDATE bot_inbox SET status = 'dispatched', dispatch_key = ?, dispatched_at_ms = ?
           WHERE id = ? AND status = 'claimed'
             AND (dispatch_key IS NULL OR dispatch_key = ?)`,
        )
        .run(dispatchKey, now, inboxId, dispatchKey);
      if (updated.changes === 0) {
        // Lost inside the same transaction: report honestly, write nothing.
        const current = this.getById(inboxId);
        if (current === null) return { state: 'absent' };
        return { state: 'not_claimed', entry: current };
      }

      const landed = this.openReceipt(dispatchKey, runId, inboxId, now);
      const updatedEntry = this.getById(inboxId);
      if (updatedEntry === null) {
        throw new Error(`bot_inbox row ${inboxId} vanished inside its own recordDispatch transaction`);
      }
      return { state: 'applied', entry: updatedEntry, receipt: landed };
    });
    return txn();
  }

  /**
   * Settle a dispatched input (§6: after the run's durable terminal lands).
   * CAS `dispatched → settled`; re-settling is a `replayed` no-op that keeps
   * the original `settled_at_ms`.
   */
  settle(inboxId: string): BotInboxSettleOutcome {
    const now = Date.now();
    const txn = this.db.transaction((): BotInboxSettleOutcome => {
      const entry = this.getById(inboxId);
      if (entry === null) return { state: 'absent' };
      if (entry.status === 'settled') return { state: 'replayed', entry };
      if (entry.status !== 'dispatched') return { state: 'not_dispatched', entry };
      const updated = this.db
        .prepare(
          `UPDATE bot_inbox SET status = 'settled', settled_at_ms = ?
           WHERE id = ? AND status = 'dispatched'`,
        )
        .run(now, inboxId);
      if (updated.changes === 0) {
        const current = this.getById(inboxId);
        if (current === null) return { state: 'absent' };
        return { state: 'not_dispatched', entry: current };
      }
      const settled = this.getById(inboxId);
      if (settled === null) {
        throw new Error(`bot_inbox row ${inboxId} vanished inside its own settle transaction`);
      }
      return { state: 'applied', entry: settled };
    });
    return txn();
  }

  /**
   * Dead-letter an input from any live status (`pending`, `claimed` or
   * `dispatched`). The first reason is durable: a repeat call is a
   * `replayed` no-op even when it offers a different reason. A settled input
   * is terminal and answers `already_settled`.
   */
  deadLetter(inboxId: string, reason: string): BotInboxDeadLetterOutcome {
    const txn = this.db.transaction((): BotInboxDeadLetterOutcome => {
      const entry = this.getById(inboxId);
      if (entry === null) return { state: 'absent' };
      if (entry.status === 'dead_letter') return { state: 'replayed', entry };
      if (entry.status === 'settled') return { state: 'already_settled', entry };
      const updated = this.db
        .prepare(
          `UPDATE bot_inbox SET status = 'dead_letter', dead_letter_reason = ?
           WHERE id = ? AND status IN ('pending','claimed','dispatched')`,
        )
        .run(reason, inboxId);
      if (updated.changes === 0) {
        const current = this.getById(inboxId);
        if (current === null) return { state: 'absent' };
        return current.status === 'settled'
          ? { state: 'already_settled', entry: current }
          : { state: 'replayed', entry: current };
      }
      const dead = this.getById(inboxId);
      if (dead === null) {
        throw new Error(`bot_inbox row ${inboxId} vanished inside its own deadLetter transaction`);
      }
      return { state: 'applied', entry: dead };
    });
    return txn();
  }

  /**
   * Mechanically requeue expired claims: `claimed` rows whose `deadline_ms`
   * has passed return to `pending`, `attempt` increments by one, and the
   * lease grant (owner + deadline) is cleared. The fencing epoch is kept —
   * see the module header. Claims without a deadline never expire here.
   * Recovery decisions (rerun, reconcile, human review) belong to S3b, which
   * must consult dispatch receipts first (§6).
   *
   * @returns the number of rows requeued.
   */
  requeueExpired(nowMs: number): number {
    const result = this.db
      .prepare(
        `UPDATE bot_inbox SET
           status = 'pending',
           lease_owner = NULL,
           deadline_ms = NULL,
           attempt = attempt + 1
         WHERE status = 'claimed' AND deadline_ms IS NOT NULL AND deadline_ms < ?`,
      )
      .run(nowMs);
    return result.changes;
  }

  /** The receipt bound to a dispatch key, or null when the key is unbound. */
  lookupReceipt(dispatchKey: string): BotDispatchReceiptRow | null {
    return this.readReceipt(dispatchKey);
  }

  /** One inbox entry by id, or null. */
  getById(id: string): BotInboxEntry | null {
    const row = this.db.prepare('SELECT * FROM bot_inbox WHERE id = ?').get(id) as
      | BotInboxDbRow
      | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  /**
   * A bot's inbox entries, oldest first. Filterable by status and lane for
   * the projections S3b and the surfaces need.
   */
  listByBot(
    botId: string,
    options: { status?: BotInboxStatus; lane?: BotInboxLane; limit?: number } = {},
  ): BotInboxEntry[] {
    const clauses: string[] = ['bot_id = @bot_id'];
    if (options.status !== undefined) {
      clauses.push('status = @status');
    }
    if (options.lane !== undefined) {
      clauses.push('lane = @lane');
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM bot_inbox WHERE ${clauses.join(' AND ')}
         ORDER BY created_ms ASC, id ASC LIMIT @limit`,
      )
      .all({
        bot_id: botId,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.lane !== undefined ? { lane: options.lane } : {}),
        limit: options.limit ?? 100,
      }) as unknown as BotInboxDbRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Import legacy `pending_wakes` markers into the inbox (§10: additive,
   * conflict-checked, never overwriting, never fabricating a user message).
   *
   * Mapping per row:
   *  - `source: 'legacy'`, dedup key `legacy\0kind\0work_id` — the old key's
   *    scope is genuinely weaker than the new one, and the shape of the key
   *    SAYS so (two separators, not four).
   *  - `bot_id` carries the marker's `agentId` (the only owner the old row
   *    had); `owner_id` is the empty string: unknown, not invented.
   *  - `payload_json` records the marker's own facts plus a scope note. It
   *    is NEVER a synthesized user message — imported rows are review
   *    obligations for the legacy path, exactly as §10's "待核对" requires.
   *  - `created_ms` carries the marker's `markedAtMs`, preserving queue age.
   *
   * A row whose kind or work id is blank cannot form a stable identity and
   * is reported `notReconstructible`. A row whose dedup key is already
   * stored is reported `conflict` and left untouched. `dryRun` runs the same
   * classification and writes nothing.
   */
  importLegacyPendingWakes(
    rows: readonly PendingWakeRow[],
    options: { dryRun: boolean },
  ): BotInboxLegacyImportReport {
    const report: BotInboxLegacyImportReport = { imported: 0, conflicts: 0, notReconstructible: 0 };
    const apply = options.dryRun
      ? (run: () => void): void => {
          run();
        }
      : (run: () => void): void => {
          this.db.transaction(run)();
        };
    apply(() => {
      for (const row of rows) {
        const kind = typeof row.kind === 'string' ? row.kind : '';
        const workId = typeof row.workId === 'string' ? row.workId : '';
        if (kind.length === 0 || workId.length === 0) {
          report.notReconstructible += 1;
          continue;
        }
        const dedupKey = composeLegacyDedupKey(kind, workId);
        const exists = this.db
          .prepare('SELECT 1 FROM bot_inbox WHERE dedup_key = ?')
          .get(dedupKey);
        if (exists !== undefined) {
          report.conflicts += 1;
          continue;
        }
        if (options.dryRun) {
          report.imported += 1;
          continue;
        }
        // Facts only. The marker predates the inbox's scope and carries no
        // message payload, so none is invented.
        const payload = {
          legacyKind: kind,
          legacyWorkId: workId,
          agentId: row.agentId,
          markedAtMs: row.markedAtMs,
          quietOriginJson: row.quietOriginJson,
          scopeNote:
            'imported from pending_wakes: the (kind, work_id) key predates owner/bot/source/binding scoping and carries no message payload',
        };
        this.db
          .prepare(
            `INSERT INTO bot_inbox (
              id, owner_id, bot_id, source, source_event_id, binding_id,
              dedup_key, status, payload_json, attempt, lane, title, created_ms
            ) VALUES (
              @id, @owner_id, @bot_id, 'legacy', @source_event_id, NULL,
              @dedup_key, 'pending', @payload_json, 0, @lane, @title, @created_ms
            )`,
          )
          .run({
            id: randomUUID(),
            owner_id: '',
            bot_id: row.agentId,
            source_event_id: workId,
            dedup_key: dedupKey,
            payload_json: JSON.stringify(payload),
            lane: row.lane,
            title: row.title,
            created_ms: row.markedAtMs,
          });
        report.imported += 1;
      }
    });
    return report;
  }

  // ─── internals ───

  private getByDedupKey(dedupKey: string): BotInboxEntry | null {
    const row = this.db.prepare('SELECT * FROM bot_inbox WHERE dedup_key = ?').get(dedupKey) as
      | BotInboxDbRow
      | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  private readReceipt(dispatchKey: string): BotDispatchReceiptRow | null {
    const row = this.db
      .prepare('SELECT * FROM bot_dispatch_receipts WHERE dispatch_key = ?')
      .get(dispatchKey) as BotDispatchReceiptDbRow | undefined;
    return row === undefined ? null : rowToReceipt(row);
  }

  /**
   * Force a receipt to `opened` and link it to `inboxId`. Idempotent by
   * construction: the caller has already established that the stored run id
   * (if any) matches, and `COALESCE` keeps an existing link from moving.
   */
  private openReceipt(
    dispatchKey: string,
    runId: string,
    inboxId: string,
    nowMs: number,
  ): BotDispatchReceiptRow {
    const updated = this.db
      .prepare(
        `UPDATE bot_dispatch_receipts SET state = 'opened', bot_inbox_id = COALESCE(bot_inbox_id, ?)
         WHERE dispatch_key = ? AND run_id = ?`,
      )
      .run(inboxId, dispatchKey, runId);
    if (updated.changes === 0) {
      this.db
        .prepare(
          `INSERT INTO bot_dispatch_receipts (dispatch_key, run_id, bot_inbox_id, state, accepted_at_ms)
           VALUES (?, ?, ?, 'opened', ?)`,
        )
        .run(dispatchKey, runId, inboxId, nowMs);
    }
    const receipt = this.readReceipt(dispatchKey);
    if (receipt === null) {
      throw new Error(`bot_dispatch_receipts row ${dispatchKey} vanished while opening`);
    }
    return receipt;
  }
}
