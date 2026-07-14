/**
 * MailboxService.ts — Agent-side service for the AgentMailbox pipeline.
 *
 * PR2 §17.2 introduces this class. It owns the agent process's view of the
 * `agent_mailbox` table and is the only authority on `claimBatch` / `apply` /
 * `cancelByAgent` / `defer` (per Plan 202 §6). It is deliberately **not** an
 * IPC client wrapper — the existing `mailboxSend` / `mailboxEdit` / etc.
 * functions in `session/db.ts` keep their IPC-mode behaviour for the renderer
 * path; `MailboxService` is the local-db path used by the run loop inside
 * the agent process.
 *
 * Phase A (this commit) ships the skeleton with method stubs. Phases B–F
 * fill in the bodies. The skeleton exists now so that `assertValidApply`
 * can be wired in and U8 (the matrix test) can land before any DB code is
 * written.
 *
 * Two reasons the class takes a `db` handle in its constructor instead of
 * importing `getDb()` directly:
 *   1. Testability: U1–U7 construct a service over an in-memory better-sqlite3
 *      with the agent_mailbox migration applied. No real DB on disk.
 *   2. Boundary: the run loop may eventually own a per-run handle with a
 *      shorter `busy_timeout`; injecting the handle keeps that open.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { MailboxApplyMode, MailboxRow } from '../session/db.js';
import { assertValidApply } from './assertValidApply.js';
import type { CheckpointType } from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface MailboxServiceOptions {
  /** Lease duration for `claimBatch`. Default 30_000 ms. */
  leaseMs?: number;
  /** Coalesce window for anchor-based batching. Default 1500 ms. Hard cap 2000 ms. */
  coalesceWindowMs?: number;
  /** Reclaim cap. After this many failed reclaims, the row is auto-cancelled. Default 5. */
  maxClaimAttempts?: number;
}

const DEFAULTS: Required<MailboxServiceOptions> = {
  leaseMs: 30_000,
  coalesceWindowMs: 1500,
  maxClaimAttempts: 5,
};

// =============================================================================
// Public types — fleshed out in Phases B–F
// =============================================================================

/** Result of `claimBatch`. Phase B will populate this fully. */
export interface ClaimBatchResult {
  rows: MailboxRow[];
  /** Fresh claim token per row. Apply / cancel must echo the token. */
  claimTokens: string[];
}

/** Input to `claimBatch`. Phase B will populate this fully. */
export interface ClaimBatchInput {
  sessionId: string;
  runId: string;
  checkpoint: CheckpointType;
  /** Hard cap on batch size. Default 10. */
  limit?: number;
}

// =============================================================================
// Service
// =============================================================================

export class MailboxService {
  private readonly db: BetterSqlite3.Database;
  private readonly options: Required<MailboxServiceOptions>;

  constructor(db: BetterSqlite3.Database, options: MailboxServiceOptions = {}) {
    this.db = db;
    this.options = { ...DEFAULTS, ...options };
    if (this.options.coalesceWindowMs > 2000) {
      // Plan 202 §13 — hard cap to keep the user from feeling ignored.
      this.options.coalesceWindowMs = 2000;
    }
  }

  /** Read-only accessor for the configured lease duration. */
  get leaseMs(): number {
    return this.options.leaseMs;
  }

  /** Read-only accessor for the configured coalesce window. */
  get coalesceWindowMs(): number {
    return this.options.coalesceWindowMs;
  }

  /** Read-only accessor for the configured reclaim cap. */
  get maxClaimAttempts(): number {
    return this.options.maxClaimAttempts;
  }

  // -------------------------------------------------------------------------
  // Phase B — claimBatch (PR2 §17.2 Phase B). Stub for now.
  // -------------------------------------------------------------------------

  /**
   * Atomically claim a coalesced batch of pending mailbox rows.
   *
   * Phase B body: anchor pick → batch select → claim UPDATE → reclaim-cap
   * enforcement. See Plan 202 §6.2.
   */
  claimBatch(input: ClaimBatchInput): ClaimBatchResult {
    const now = Date.now();
    const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
    const txn = this.db.transaction((): ClaimBatchResult => {
      const anchor = this.db.prepare(`
        SELECT id, priority, created_at, status, claim_attempts
        FROM agent_mailbox
        WHERE session_id = @sessionId
          AND (apply_mode = 'runtime_instruction' OR kind IN ('stop', 'abort_and_replace'))
          AND (
            status = 'pending'
            OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @now)
          )
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
      `).get({ sessionId: input.sessionId, now }) as Pick<MailboxRow, 'id' | 'priority' | 'created_at' | 'status' | 'claim_attempts'> | undefined;

      if (!anchor) return { rows: [], claimTokens: [] };
      if (anchor.status === 'observed' && anchor.claim_attempts >= this.options.maxClaimAttempts) {
        this.db.prepare(`
          UPDATE agent_mailbox
          SET status = 'cancelled',
              cancelled_at = @now,
              cancelled_by = 'system:max_claim_attempts',
              cancel_reason = 'max_claim_attempts_exceeded',
              failure_reason = 'max_claim_attempts_exceeded'
          WHERE id = @id AND status = 'observed'
        `).run({ id: anchor.id, now });
        return { rows: [], claimTokens: [] };
      }

      const rowsToClaim = this.db.prepare(`
        SELECT *
        FROM agent_mailbox
        WHERE session_id = @sessionId
          AND priority = @priority
          AND created_at <= @windowEnd
          AND (apply_mode = 'runtime_instruction' OR kind IN ('stop', 'abort_and_replace'))
          AND (
            status = 'pending'
            OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @now)
          )
        ORDER BY priority ASC, created_at ASC
        LIMIT @limit
      `).all({
        sessionId: input.sessionId,
        priority: anchor.priority,
        windowEnd: anchor.created_at + this.options.coalesceWindowMs,
        now,
        limit,
      }) as MailboxRow[];

      const rows: MailboxRow[] = [];
      const claimTokens: string[] = [];
      for (const row of rowsToClaim) {
        if (row.status === 'observed' && row.claim_attempts >= this.options.maxClaimAttempts) {
          this.db.prepare(`
            UPDATE agent_mailbox
            SET status = 'cancelled',
                cancelled_at = @now,
                cancelled_by = 'system:max_claim_attempts',
                cancel_reason = 'max_claim_attempts_exceeded',
                failure_reason = 'max_claim_attempts_exceeded'
            WHERE id = @id AND status = 'observed'
          `).run({ id: row.id, now });
          continue;
        }

        const claimToken = randomUUID();
        const result = this.db.prepare(`
          UPDATE agent_mailbox
          SET status = 'observed',
              claim_token = @claimToken,
              claim_expires_at = @claimExpiresAt,
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
            )
        `).run({
          id: row.id,
          claimToken,
          claimExpiresAt: now + this.options.leaseMs,
          now,
          checkpoint: input.checkpoint,
          runId: input.runId,
        });

        if (result.changes > 0) {
          rows.push(this.db.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(row.id) as MailboxRow);
          claimTokens.push(claimToken);
        }
      }

      return { rows, claimTokens };
    });

    return txn();
  }

  // -------------------------------------------------------------------------
  // Phase C — apply / cancelByAgent / defer. Stubs for now.
  // -------------------------------------------------------------------------

  /**
   * Transition an observed row to `applied` with a chosen mode.
   *
   * Phase C body: assert valid pair via `assertValidApply` → write the
   * resulting `messages` row (when `promote_to_user_message`) in the same
   * transaction. See Plan 202 §6.5.
   */
  apply(input: {
    id: string;
    claimToken: string;
    mode: MailboxApplyMode;
    checkpoint: CheckpointType;
    summary: string;
    newUserMsgId?: string;
  }): MailboxRow {
    assertValidApply(input.checkpoint, input.mode);
    const now = Date.now();
    const txn = this.db.transaction((): MailboxRow => {
      const result = this.db.prepare(`
        UPDATE agent_mailbox
        SET status = 'applied',
            apply_mode = @mode,
            applied_at = @now,
            applied_at_checkpoint = @checkpoint,
            applied_summary = @summary,
            resulting_user_msg_id = @newUserMsgId,
            claim_expires_at = NULL
        WHERE id = @id
          AND status = 'observed'
          AND claim_token = @claimToken
      `).run({
        id: input.id,
        claimToken: input.claimToken,
        mode: input.mode,
        now,
        checkpoint: input.checkpoint,
        summary: input.summary,
        newUserMsgId: input.newUserMsgId ?? null,
      });

      if (result.changes === 0) {
        throw new Error('Mailbox apply failed: row is not observed or claim token is stale');
      }
      return this.db.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(input.id) as MailboxRow;
    });
    return txn();
  }

  /**
   * Apply as `deferred_to_next_turn` AND pair with a fresh `pending` mirror
   * row in the same transaction. The original reaches `applied` (terminal);
   * the mirror is what the next checkpoint actually consumes.
   */
  defer(input: { id: string; claimToken: string; reason: string; checkpoint: CheckpointType }): void {
    const row = this.apply({
      id: input.id,
      claimToken: input.claimToken,
      mode: 'deferred_to_next_turn',
      checkpoint: input.checkpoint,
      summary: input.reason,
    });
    this.db.prepare(`
      INSERT INTO agent_mailbox (
        id, session_id, submitted_during_run_id, content, kind, status,
        priority, constraints_json, attachments_json, source, client_msg_id, created_at
      ) VALUES (
        @id, @sessionId, @runId, @content, @kind, 'pending',
        @priority, @constraintsJson, @attachmentsJson, 'system', NULL, @createdAt
      )
    `).run({
      id: randomUUID(),
      sessionId: row.session_id,
      runId: row.observed_by_run_id ?? row.submitted_during_run_id,
      content: row.content,
      kind: row.kind,
      priority: row.priority,
      constraintsJson: row.constraints_json,
      attachmentsJson: row.attachments_json,
      createdAt: Date.now(),
    });
  }

  /**
   * Cancel an observed row (status=`observed` only). Renderer cannot reach
   * this path. Used for stale claims, invalid apply pre-conditions, or
   * `max_claim_attempts` reached.
   */
  cancelByAgent(input: { id: string; claimToken: string; reason: string }): void {
    const result = this.db.prepare(`
      UPDATE agent_mailbox
      SET status = 'cancelled',
          cancelled_at = @now,
          cancelled_by = 'agent',
          cancel_reason = @reason,
          failure_reason = @reason,
          claim_expires_at = NULL
      WHERE id = @id
        AND status = 'observed'
        AND claim_token = @claimToken
    `).run({
      id: input.id,
      claimToken: input.claimToken,
      reason: input.reason,
      now: Date.now(),
    });
    if (result.changes === 0) {
      throw new Error('Mailbox cancel failed: row is not observed or claim token is stale');
    }
  }
}
