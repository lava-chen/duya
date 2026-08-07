/**
 * Mailbox — state machine for `mailbox_items` (queued/followup/background_notification).
 *
 * Ports the claim/apply/defer/cancel/guide/promoteQueued state machine previously
 * duplicated across `electron/agents/db-bridge.ts` (live `agent_mailbox` path) and
 * `packages/agent/src/mailbox/MailboxService.ts` (deleted dead code, Phase 0 of
 * plan 327). The apply matrix (25 permitted `checkpoint:mode` pairs, Plan 202 §5.2)
 * is exposed as `Mailbox.assertApplyAllowed` — the single source of truth.
 *
 * Plan 328 rewired `db-handlers.ts` mailbox IPC handlers and `db-bridge.ts`
 * mailbox cases to call into this class; the legacy `mailbox-transitions.ts`
 * (old `agent_mailbox` table path) has been deleted.
 *
 * Column changes vs the legacy `agent_mailbox` table (design doc §mailbox_items):
 *  - `submitted_during_run_id` → `submitted_run_id`
 *  - `attachments_json`         → `attachments` (TEXT, JSON-serialized)
 *  - `constraints_json` + `edit_history_json` → `meta` (single JSON column)
 *  - `failure_reason` collapsed into `cancel_reason`
 *  - `resulting_user_msg_id` → `resulting_event_id`
 *
 * See `docs/design-docs/2026-08-06-core-database-architecture.md` for the DDL.
 */

import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './database';

// ─── Inline types ───

export type MailboxKind = 'queued' | 'followup' | 'background_notification';
export type MailboxStatus = 'pending' | 'observed' | 'applied' | 'cancelled';
export type MailboxApplyMode =
  | 'promote_to_user_message'
  | 'runtime_instruction'
  | 'tool_guard'
  | 'permission_context'
  | 'interrupt_signal'
  | 'deferred_to_next_turn';

export type CheckpointType =
  | 'before_model_turn'
  | 'after_model_turn'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_file_write'
  | 'before_shell_command'
  | 'before_final_answer'
  | 'on_permission_request'
  | 'on_error_recovery';

export interface MailboxItem {
  id: string;
  sessionId: string;
  kind: MailboxKind;
  status: MailboxStatus;
  priority: number;
  content: string;
  attachments: unknown[] | null;
  source: string;
  clientMsgId: string | null;
  submittedRunId: string;
  claimToken: string | null;
  claimExpiresAt: number | null;
  claimAttempts: number;
  lastClaimError: string | null;
  observedAt: number | null;
  observedAtCheckpoint: string | null;
  observedByRunId: string | null;
  applyMode: MailboxApplyMode | null;
  appliedAt: number | null;
  appliedAtCheckpoint: string | null;
  appliedSummary: string | null;
  resultingEventId: string | null;
  editLockedAt: number | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface EnqueueInput {
  id: string;
  sessionId: string;
  submittedRunId: string;
  content: string;
  kind: MailboxKind;
  attachments?: unknown[];
  clientMsgId?: string | null;
  source?: string;
  meta?: Record<string, unknown>;
}

export interface EditInput {
  content?: string;
  kind?: MailboxKind;
}

export interface ClaimBatchInput {
  sessionId: string;
  runId: string;
  checkpoint: CheckpointType;
  limit?: number;
  leaseMs?: number;
  coalesceWindowMs?: number;
  maxClaimAttempts?: number;
}

export interface ClaimBatchResult {
  rows: MailboxItem[];
  claimTokens: string[];
}

export interface ApplyInput {
  id: string;
  claimToken: string;
  mode: MailboxApplyMode;
  checkpoint: CheckpointType;
  summary?: string;
  resultingEventId?: string | null;
}

export interface CancelByAgentInput {
  id: string;
  claimToken: string;
  reason: string;
}

// ─── Apply matrix (single source of truth, Plan 202 §5.2) ───

/**
 * 25 permitted `checkpoint:mode` pairs. Stored as a Set for O(1) lookup.
 * Plan 320's dual-copy issue (db-bridge `MAILBOX_PERMITTED_APPLY` + agent-side
 * `assertValidApply`) is resolved here: this Set is the only permitted matrix.
 */
const PERMITTED_APPLY_PAIRS: ReadonlySet<string> = new Set<string>([
  // before_model_turn (3)
  'before_model_turn:promote_to_user_message',
  'before_model_turn:runtime_instruction',
  'before_model_turn:interrupt_signal',
  // after_model_turn (3)
  'after_model_turn:runtime_instruction',
  'after_model_turn:interrupt_signal',
  'after_model_turn:deferred_to_next_turn',
  // before_tool_call (3)
  'before_tool_call:tool_guard',
  'before_tool_call:interrupt_signal',
  'before_tool_call:runtime_instruction',
  // after_tool_call (4)
  'after_tool_call:runtime_instruction',
  'after_tool_call:tool_guard',
  'after_tool_call:interrupt_signal',
  'after_tool_call:deferred_to_next_turn',
  // before_file_write (2)
  'before_file_write:tool_guard',
  'before_file_write:interrupt_signal',
  // before_shell_command (2)
  'before_shell_command:tool_guard',
  'before_shell_command:interrupt_signal',
  // before_final_answer (3) — promote_to_user_message here triggers a NEW TURN
  'before_final_answer:promote_to_user_message',
  'before_final_answer:runtime_instruction',
  'before_final_answer:interrupt_signal',
  // on_permission_request (2)
  'on_permission_request:permission_context',
  'on_permission_request:interrupt_signal',
  // on_error_recovery (3)
  'on_error_recovery:runtime_instruction',
  'on_error_recovery:interrupt_signal',
  'on_error_recovery:deferred_to_next_turn',
]);

/**
 * Thrown when an `apply` call violates the matrix. The agent run loop catches
 * it and rolls back the surrounding transaction.
 */
export class ApplyViolationError extends Error {
  readonly checkpoint: CheckpointType;
  readonly mode: MailboxApplyMode;

  constructor(checkpoint: CheckpointType, mode: MailboxApplyMode) {
    super(`apply(mode=${mode}) is not permitted at checkpoint=${checkpoint} (see Plan 202 §5.2)`);
    this.name = 'ApplyViolationError';
    this.checkpoint = checkpoint;
    this.mode = mode;
  }
}

// ─── Mailbox ───

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_COALESCE_WINDOW_MS = 1500;
const COALESCE_WINDOW_HARD_CAP_MS = 2000;
const DEFAULT_MAX_CLAIM_ATTEMPTS = 5;
const DEFAULT_LIMIT = 10;
const LIMIT_HARD_CAP = 25;
const KIND_PRIORITY: Record<MailboxKind, number> = {
  followup: 10,
  background_notification: 50,
  queued: 100,
};

export class Mailbox {
  /** Migration id=4: create mailbox_items table + claim index + client_msg_id index. */
  static readonly migrations: Migration[] = [
    {
      id: 4,
      name: 'create_mailbox_items',
      up: (db) => {
        db.exec(`
          CREATE TABLE mailbox_items (
            id                     TEXT PRIMARY KEY,
            session_id             TEXT NOT NULL,
            kind                   TEXT NOT NULL
              CHECK (kind IN ('queued','followup','background_notification')),
            status                 TEXT NOT NULL
              CHECK (status IN ('pending','observed','applied','cancelled')),
            priority               INTEGER NOT NULL DEFAULT 100,
            content                TEXT NOT NULL,
            attachments            TEXT,
            source                 TEXT NOT NULL DEFAULT 'ui',
            client_msg_id          TEXT,
            submitted_run_id       TEXT NOT NULL,
            claim_token            TEXT,
            claim_expires_at       INTEGER,
            claim_attempts         INTEGER NOT NULL DEFAULT 0,
            last_claim_error       TEXT,
            observed_at            INTEGER,
            observed_at_checkpoint TEXT,
            observed_by_run_id     TEXT,
            apply_mode             TEXT,
            applied_at             INTEGER,
            applied_at_checkpoint  TEXT,
            applied_summary        TEXT,
            resulting_event_id     TEXT,
            edit_locked_at         INTEGER,
            cancelled_at           INTEGER,
            cancelled_by           TEXT,
            cancel_reason          TEXT,
            meta                   TEXT NOT NULL DEFAULT '{}',
            created_at             INTEGER NOT NULL
          );
          CREATE INDEX idx_mailbox_claim_ready
            ON mailbox_items(session_id, status, priority, created_at)
            WHERE status = 'pending'
               OR (observed_at IS NOT NULL AND claim_expires_at IS NOT NULL);
          CREATE UNIQUE INDEX uq_mailbox_client_msg
            ON mailbox_items(session_id, client_msg_id)
            WHERE client_msg_id IS NOT NULL;
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ─── Apply matrix ───

  /**
   * Assert that `mode` is a permitted `apply_mode` at `checkpoint`. Throws
   * `ApplyViolationError` on a forbidden pair; the surrounding transaction
   * rolls back. Single source of truth for the matrix — Plan 320 §C2.
   */
  static assertApplyAllowed(checkpoint: CheckpointType, mode: MailboxApplyMode): void {
    if (!PERMITTED_APPLY_PAIRS.has(`${checkpoint}:${mode}`)) {
      throw new ApplyViolationError(checkpoint, mode);
    }
  }

  /** Predicate form. Useful for the run loop's pre-check before claiming. */
  static isValidApply(checkpoint: CheckpointType, mode: MailboxApplyMode): boolean {
    return PERMITTED_APPLY_PAIRS.has(`${checkpoint}:${mode}`);
  }

  // ─── Enqueue ───

  /**
   * Insert a pending row. If `clientMsgId` matches an existing row for the
   * same session, the existing row is returned unchanged (idempotent retry).
   */
  enqueue(input: EnqueueInput): MailboxItem {
    const now = Date.now();
    const priority = KIND_PRIORITY[input.kind] ?? 100;
    if (input.clientMsgId) {
      const existing = this.db
        .prepare('SELECT * FROM mailbox_items WHERE session_id = ? AND client_msg_id = ?')
        .get(input.sessionId, input.clientMsgId) as MailboxRow | undefined;
      if (existing) return rowToItem(existing);
    }
    this.db
      .prepare(
        `INSERT INTO mailbox_items (
          id, session_id, kind, status, priority, content, attachments, source,
          client_msg_id, submitted_run_id, meta, created_at
        ) VALUES (
          @id, @session_id, @kind, 'pending', @priority, @content, @attachments, @source,
          @client_msg_id, @submitted_run_id, @meta, @created_at
        )`,
      )
      .run({
        id: input.id,
        session_id: input.sessionId,
        kind: input.kind,
        priority,
        content: input.content,
        attachments: input.attachments ? JSON.stringify(input.attachments) : null,
        source: input.source ?? 'ui',
        client_msg_id: input.clientMsgId ?? null,
        submitted_run_id: input.submittedRunId,
        meta: JSON.stringify(input.meta ?? {}),
        created_at: now,
      });
    return this.get(input.id)!;
  }

  // ─── Edit / guide / promoteQueued ───

  /**
   * Edit content/kind on a pending, unlocked row. Edits append to `meta.editHistory`.
   * Returns the updated row, or null if the row is missing / not pending / locked.
   */
  edit(id: string, patch: EditInput): MailboxItem | null {
    const existing = this.db.prepare('SELECT * FROM mailbox_items WHERE id = ?').get(id) as MailboxRow | undefined;
    if (!existing) return null;
    if (existing.status !== 'pending') return null;
    if (existing.edit_locked_at !== null) return null;

    const now = Date.now();
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    const meta: Record<string, unknown> = safeParse(existing.meta);
    const editHistory = Array.isArray(meta.editHistory) ? meta.editHistory : [];
    if (patch.content !== undefined) {
      editHistory.push({ editedAt: now, prevContent: existing.content, prevKind: existing.kind });
      fields.push('content = @content');
      params.content = patch.content;
    }
    if (patch.kind !== undefined) {
      if (!editHistory.some((e: EditHistoryEntry) => e.prevKind === existing.kind && e.editedAt === now)) {
        editHistory.push({ editedAt: now, prevContent: existing.content, prevKind: existing.kind });
      }
      fields.push('kind = @kind');
      fields.push('priority = @priority');
      params.kind = patch.kind;
      params.priority = KIND_PRIORITY[patch.kind] ?? 100;
    }
    if (fields.length === 0) return rowToItem(existing);

    meta.editHistory = editHistory;
    fields.push('meta = @meta');
    params.meta = JSON.stringify(meta);

    this.db.prepare(`UPDATE mailbox_items SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  /**
   * Reclassify a pending row as an immediate followup: set `kind='followup'`
   * and `apply_mode='runtime_instruction'` so `before_model_turn` claims it.
   * Returns the row (idempotent on re-click) or null if missing / not pending.
   */
  guide(id: string): MailboxItem | null {
    const existing = this.db.prepare('SELECT * FROM mailbox_items WHERE id = ?').get(id) as MailboxRow | undefined;
    if (!existing || existing.status !== 'pending') return null;
    this.db
      .prepare(
        `UPDATE mailbox_items
         SET apply_mode = 'runtime_instruction', kind = 'followup'
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ id });
    return this.get(id);
  }

  /**
   * Promote a queued row (status=pending, apply_mode != 'runtime_instruction')
   * to applied with `apply_mode='promote_to_user_message'` so the next user
   * turn consumes it. Mirrors the legacy `promoteQueuedMailbox` semantics.
   * Returns the row or null if not eligible (already observed, guided, etc.).
   */
  promoteQueued(sessionId: string, id: string, now: number = Date.now()): MailboxItem | null {
    const result = this.db
      .prepare(
        `UPDATE mailbox_items
         SET status = 'applied',
             apply_mode = 'promote_to_user_message',
             applied_at = @now,
             applied_at_checkpoint = 'after_current_run',
             applied_summary = 'queued_for_next_agent_turn',
             claim_expires_at = NULL
         WHERE id = @id
           AND session_id = @sessionId
           AND status = 'pending'
           AND (apply_mode IS NULL OR apply_mode <> 'runtime_instruction')`,
      )
      .run({ id, sessionId, now });
    if (result.changes === 0) return null;
    return this.get(id);
  }

  // ─── Cancel ───

  /**
   * User-initiated cancel of a pending row. Sets `cancelled_by='user'`. Only
   * pending rows can be cancelled by the user (observed rows are owned by the
   * agent run loop and require `cancelByAgent`).
   */
  cancel(id: string, reason?: string, by: string = 'user'): MailboxItem | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE mailbox_items
         SET status = 'cancelled',
             cancelled_at = @now,
             cancelled_by = @by,
             cancel_reason = @reason
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ id, now, by, reason: reason ?? null });
    if (result.changes === 0) return null;
    return this.get(id);
  }

  /**
   * Agent-initiated cancel of an observed row. Requires `claimToken` match.
   * Used for stale claims, invalid apply pre-conditions, or max_claim_attempts.
   */
  cancelByAgent(input: CancelByAgentInput): MailboxItem | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE mailbox_items
         SET status = 'cancelled',
             cancelled_at = @now,
             cancelled_by = 'agent',
             cancel_reason = @reason,
             claim_expires_at = NULL
         WHERE id = @id
           AND status = 'observed'
           AND claim_token = @claimToken`,
      )
      .run({ id: input.id, claimToken: input.claimToken, reason: input.reason, now });
    if (result.changes === 0) return null;
    return this.get(input.id);
  }

  // ─── ClaimBatch ───

  /**
   * Atomically claim a coalesced batch of pending (or expired observed) rows.
   *
   * Claimable kinds depend on checkpoint:
   *  - `before_final_answer` allows followup + queued + background_notification
   *  - all other checkpoints allow followup + background_notification only
   *
   * Auto-cancels rows hitting `maxClaimAttempts`. CAS-claims each row with a
   * fresh `claim_token` and `claim_expires_at = now + leaseMs`. Reclaiming an
   * expired observed row increments `claim_attempts`.
   */
  claimBatch(input: ClaimBatchInput): ClaimBatchResult {
    const now = Date.now();
    const leaseMs = Math.max(1000, input.leaseMs ?? DEFAULT_LEASE_MS);
    const coalesceWindowMs = Math.min(
      Math.max(0, input.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS),
      COALESCE_WINDOW_HARD_CAP_MS,
    );
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, LIMIT_HARD_CAP));
    const maxClaimAttempts = Math.max(1, input.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS);

    const claimableKinds =
      input.checkpoint === 'before_final_answer'
        ? "'followup','queued','background_notification'"
        : "'followup','background_notification'";

    const txn = this.db.transaction((): ClaimBatchResult => {
      const anchor = this.db
        .prepare(
          `SELECT id, priority, created_at, status, claim_attempts
           FROM mailbox_items
           WHERE session_id = @sessionId
             AND kind IN (${claimableKinds})
             AND (
               status = 'pending'
               OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @now)
             )
           ORDER BY priority ASC, created_at ASC
           LIMIT 1`,
        )
        .get({ sessionId: input.sessionId, now }) as
        | { id: string; priority: number; created_at: number; status: string; claim_attempts: number }
        | undefined;

      if (!anchor) return { rows: [], claimTokens: [] };

      if (anchor.status === 'observed' && anchor.claim_attempts >= maxClaimAttempts) {
        this.db
          .prepare(
            `UPDATE mailbox_items
             SET status = 'cancelled',
                 cancelled_at = @now,
                 cancelled_by = 'system:max_claim_attempts',
                 cancel_reason = 'max_claim_attempts_exceeded'
             WHERE id = @id AND status = 'observed'`,
          )
          .run({ id: anchor.id, now });
        return { rows: [], claimTokens: [] };
      }

      const windowEnd = anchor.created_at + coalesceWindowMs;
      const candidates = this.db
        .prepare(
          `SELECT *
           FROM mailbox_items
           WHERE session_id = @sessionId
             AND priority = @priority
             AND created_at <= @windowEnd
             AND kind IN (${claimableKinds})
             AND (
               status = 'pending'
               OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @now)
             )
           ORDER BY priority ASC, created_at ASC
           LIMIT @limit`,
        )
        .all({
          sessionId: input.sessionId,
          priority: anchor.priority,
          windowEnd,
          now,
          limit,
        }) as MailboxRow[];

      const rows: MailboxItem[] = [];
      const claimTokens: string[] = [];
      for (const candidate of candidates) {
        if (candidate.status === 'observed' && candidate.claim_attempts >= maxClaimAttempts) {
          this.db
            .prepare(
              `UPDATE mailbox_items
               SET status = 'cancelled',
                   cancelled_at = @now,
                   cancelled_by = 'system:max_claim_attempts',
                   cancel_reason = 'max_claim_attempts_exceeded'
               WHERE id = @id AND status = 'observed'`,
            )
            .run({ id: candidate.id, now });
          continue;
        }

        const token = randomUUID();
        const result = this.db
          .prepare(
            `UPDATE mailbox_items
             SET status = 'observed',
                 claim_token = @token,
                 claim_expires_at = @expiresAt,
                 observed_at = COALESCE(observed_at, @now),
                 observed_at_checkpoint = COALESCE(observed_at_checkpoint, @checkpoint),
                 observed_by_run_id = @runId,
                 edit_locked_at = COALESCE(edit_locked_at, @now),
                 claim_attempts = claim_attempts + CASE WHEN status = 'observed' THEN 1 ELSE 0 END,
                 last_claim_error = NULL
             WHERE id = @id
               AND (
                 status = 'pending'
                 OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @now)
               )`,
          )
          .run({
            id: candidate.id,
            token,
            expiresAt: now + leaseMs,
            now,
            checkpoint: input.checkpoint,
            runId: input.runId,
          });

        if (result.changes > 0) {
          rows.push(this.get(candidate.id)!);
          claimTokens.push(token);
        }
      }

      return { rows, claimTokens };
    });

    return txn();
  }

  // ─── Apply ───

  /**
   * Transition an observed row to `applied` with `mode` at `checkpoint`.
   * Validates against the apply matrix first, then UPDATEs gated on
   * `id + status='observed' + claim_token`. Throws on stale token.
   */
  apply(input: ApplyInput): MailboxItem {
    Mailbox.assertApplyAllowed(input.checkpoint, input.mode);
    const now = Date.now();
    const txn = this.db.transaction((): MailboxItem => {
      const result = this.db
        .prepare(
          `UPDATE mailbox_items
           SET status = 'applied',
               apply_mode = @mode,
               applied_at = @now,
               applied_at_checkpoint = @checkpoint,
               applied_summary = @summary,
               resulting_event_id = @resultingEventId,
               claim_expires_at = NULL
           WHERE id = @id
             AND status = 'observed'
             AND claim_token = @claimToken`,
        )
        .run({
          id: input.id,
          claimToken: input.claimToken,
          mode: input.mode,
          now,
          checkpoint: input.checkpoint,
          summary: input.summary ?? null,
          resultingEventId: input.resultingEventId ?? null,
        });
      if (result.changes === 0) {
        throw new Error('Mailbox apply failed: row is not observed or claim token is stale');
      }
      return this.get(input.id)!;
    });
    return txn();
  }

  /**
   * Apply as `deferred_to_next_turn` AND insert a fresh `pending` mirror row
   * in the same transaction. The original reaches `applied` (terminal); the
   * mirror is what the next checkpoint actually consumes.
   */
  defer(input: {
    id: string;
    claimToken: string;
    reason: string;
    checkpoint: CheckpointType;
  }): MailboxItem {
    const applied = this.apply({
      id: input.id,
      claimToken: input.claimToken,
      mode: 'deferred_to_next_turn',
      checkpoint: input.checkpoint,
      summary: input.reason,
    });
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_items (
          id, session_id, kind, status, priority, content, attachments, source,
          client_msg_id, submitted_run_id, meta, created_at
        ) VALUES (
          @id, @sessionId, @kind, 'pending', @priority, @content, @attachments, 'system',
          NULL, @runId, @meta, @createdAt
        )`,
      )
      .run({
        id: randomUUID(),
        sessionId: applied.sessionId,
        kind: applied.kind,
        priority: applied.priority,
        content: applied.content,
        attachments: applied.attachments ? JSON.stringify(applied.attachments) : null,
        runId: applied.observedByRunId ?? applied.submittedRunId,
        meta: JSON.stringify(applied.meta),
        createdAt: now,
      });
    return applied;
  }

  // ─── List ───

  list(sessionId: string, opts: { status?: MailboxStatus[]; limit?: number } = {}): MailboxItem[] {
    const limit = opts.limit ?? 50;
    const statuses = opts.status;
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM mailbox_items WHERE session_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sessionId, ...statuses, limit) as MailboxRow[];
      return rows.map(rowToItem);
    }
    const rows = this.db
      .prepare('SELECT * FROM mailbox_items WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as MailboxRow[];
    return rows.map(rowToItem);
  }

  listForSession(sessionId: string): MailboxItem[] {
    const rows = this.db
      .prepare('SELECT * FROM mailbox_items WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as MailboxRow[];
    return rows.map(rowToItem);
  }

  /** Internal accessor for a single row. */
  get(id: string): MailboxItem | null {
    const row = this.db.prepare('SELECT * FROM mailbox_items WHERE id = ?').get(id) as MailboxRow | undefined;
    return row ? rowToItem(row) : null;
  }
}

// ─── Helpers ───

interface MailboxRow {
  id: string;
  session_id: string;
  kind: MailboxKind;
  status: MailboxStatus;
  priority: number;
  content: string;
  attachments: string | null;
  source: string;
  client_msg_id: string | null;
  submitted_run_id: string;
  claim_token: string | null;
  claim_expires_at: number | null;
  claim_attempts: number;
  last_claim_error: string | null;
  observed_at: number | null;
  observed_at_checkpoint: string | null;
  observed_by_run_id: string | null;
  apply_mode: MailboxApplyMode | null;
  applied_at: number | null;
  applied_at_checkpoint: string | null;
  applied_summary: string | null;
  resulting_event_id: string | null;
  edit_locked_at: number | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  meta: string;
  created_at: number;
}

interface EditHistoryEntry {
  editedAt: number;
  prevContent: string;
  prevKind: string;
}

function rowToItem(row: MailboxRow): MailboxItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    content: row.content,
    attachments: row.attachments ? safeParseArray(row.attachments) : null,
    source: row.source,
    clientMsgId: row.client_msg_id,
    submittedRunId: row.submitted_run_id,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    claimAttempts: row.claim_attempts,
    lastClaimError: row.last_claim_error,
    observedAt: row.observed_at,
    observedAtCheckpoint: row.observed_at_checkpoint,
    observedByRunId: row.observed_by_run_id,
    applyMode: row.apply_mode,
    appliedAt: row.applied_at,
    appliedAtCheckpoint: row.applied_at_checkpoint,
    appliedSummary: row.applied_summary,
    resultingEventId: row.resulting_event_id,
    editLockedAt: row.edit_locked_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    meta: safeParse(row.meta),
    createdAt: row.created_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeParseArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
