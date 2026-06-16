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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  claimBatch(input: ClaimBatchInput): ClaimBatchResult {
    throw new Error('MailboxService.claimBatch is not yet implemented (PR2 Phase B)');
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  apply(input: {
    id: string;
    claimToken: string;
    mode: MailboxApplyMode;
    checkpoint: CheckpointType;
    summary: string;
    newUserMsgId?: string;
  }): MailboxRow {
    // assertValidApply will be called once `input.checkpoint` and `input.mode`
    // are bound. The stub is here so the public surface is stable.
    void assertValidApply;
    throw new Error('MailboxService.apply is not yet implemented (PR2 Phase C)');
  }

  /**
   * Apply as `deferred_to_next_turn` AND pair with a fresh `pending` mirror
   * row in the same transaction. The original reaches `applied` (terminal);
   * the mirror is what the next checkpoint actually consumes.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  defer(input: { id: string; claimToken: string; reason: string; checkpoint: CheckpointType }): void {
    throw new Error('MailboxService.defer is not yet implemented (PR2 Phase C)');
  }

  /**
   * Cancel an observed row (status=`observed` only). Renderer cannot reach
   * this path. Used for stale claims, invalid apply pre-conditions, or
   * `max_claim_attempts` reached.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cancelByAgent(input: { id: string; claimToken: string; reason: string }): void {
    throw new Error('MailboxService.cancelByAgent is not yet implemented (PR2 Phase C)');
  }
}
