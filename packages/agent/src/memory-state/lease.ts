import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Memory lease lifecycle (Plan 302 Phase B, design v3 D4).
 *
 * Acquire / heartbeat / CAS-complete / fail-with-backoff / retire for
 * Stage 1 rollout extraction. Every public function takes the DB
 * handle as its first parameter (explicit deviation from the plan's
 * input-object signature: packages/agent must not import the Electron
 * DB singleton; Plan 305 wires a concrete handle).
 *
 * Correctness contracts:
 *   - A fixed 10-minute TTL alone is unsafe for long LLM calls → the
 *     holder heartbeats every TTL/6 to extend `expires_at`; completion
 *     rejects workers whose heartbeat went stale (STALE_WORKER_GRACE_MS).
 *   - Concurrent acquire of a live lease returns Busy (never a shared
 *     token) unless the caller passes an explicit `idempotencyToken`
 *     matching the holder, which returns the prior token unchanged.
 *   - `attempt_count` survives per-attempt lease replacement; permanent
 *     failure history lands in `rollout_retired` when the attempt count
 *     reaches MAX_RETRY_ATTEMPTS.
 *   - Completion is CAS-protected against three races:
 *       (a) lease loss (token mismatch / not running) → 'stale_lease'
 *       (b) worker abandonment                        → 'stale_worker'
 *       (c) source-version drift vs. the lease snapshot → 'source_changed'
 *
 * Shadow mode: no production caller until Plans 304/305 wire the
 * extractor and worker.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_TTL_MS = 600_000; // 10 minutes
export const HEARTBEAT_DIVISOR = 6; // heartbeat every TTL/6 (~100s at default)
export const MAX_RETRY_ATTEMPTS = 10;
/** Backoff minutes for attempts 1..9 (index = attempt - 1). */
export const BACKOFF_SEQUENCE_MINUTES = [5, 15, 60, 360, 360, 360, 1440, 1440, 1440];
/** Two missed heartbeat intervals marks the worker abandoned. */
export const STALE_WORKER_GRACE_MS = 2 * (DEFAULT_LEASE_TTL_MS / HEARTBEAT_DIVISOR); // 200_000

/**
 * Sentinel value written to stage1_outputs.project_id. The memory system
 * is global-only; the column remains NOT NULL for backward compatibility
 * and is always set to 'global'.
 */
const GLOBAL_PROJECT_ID = 'global';

// ---------------------------------------------------------------------------
// Row types (mirror migration 0002 columns 1:1)
// ---------------------------------------------------------------------------

export type LeaseJobStatus = 'running' | 'failed' | 'reclaiming';

export interface RolloutLeaseRow {
  rollout_id: string;
  token: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  attempt_count: number;
  next_retry_at: number | null;
  claimed_by: string;
  idempotency_token: string | null;
  last_error: string | null;
  source_updated_at: number;
  source_content_hash: string;
  job_status: LeaseJobStatus;
}

export type Stage1JobStatus = 'succeeded' | 'succeeded_no_output';
export type ContentOutcome = 'success' | 'partial' | 'fail' | 'uncertain';

// ---------------------------------------------------------------------------
// Backoff (pure, exported for isolated testing)
// ---------------------------------------------------------------------------

/**
 * Retry backoff in milliseconds for the given attempt count, or `null`
 * when the rollout must be permanently retired
 * (attempt >= MAX_RETRY_ATTEMPTS).
 *
 * Schedule: 1→5min, 2→15min, 3→1h, 4-6→6h, 7-9→24h, ≥10→retire.
 */
export function backoffMs(attemptCount: number): number | null {
  if (attemptCount >= MAX_RETRY_ATTEMPTS) return null;
  const index = Math.min(Math.max(attemptCount, 1), BACKOFF_SEQUENCE_MINUTES.length) - 1;
  return BACKOFF_SEQUENCE_MINUTES[index] * 60 * 1000;
}

/** Alias of backoffMs kept for the existing backoff test suite. */
export const computeRetryBackoffMs = backoffMs;

/** True when the given attempt count reaches permanent retirement. */
export function shouldRetire(attemptCount: number): boolean {
  return attemptCount >= MAX_RETRY_ATTEMPTS;
}

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

export interface AcquireOk {
  status: 'acquired';
  token: string;
  expiresAt: number; // ms
}

export interface AcquireBusy {
  status: 'busy';
  holder: string;
  /**
   * ms; for a running lease its `expires_at`, for a backed-off failed
   * lease its `next_retry_at`, 0 for a retired rollout.
   */
  expiresAt: number;
}

export type AcquireResult = AcquireOk | AcquireBusy;

interface CatalogSnapshotRow {
  last_message_at: number | null;
  source_fingerprint: string | null;
}

/**
 * Acquire a lease on a rollout. Single BEGIN IMMEDIATE transaction;
 * reads the existing lease row (if any) and upserts.
 *
 * Returns Acquired with a fresh UUID v4 token only if:
 *   1. no lease row exists, or
 *   2. the row is 'running' but already expired (TTL passed), or
 *   3. the row is 'failed' and its backoff has elapsed
 *      (next_retry_at IS NULL or <= now), or
 *   4. the row is 'reclaiming'.
 * Cases 2-4 bump attempt_count to prev + 1; fresh inserts start at 1.
 *
 * Returns Busy when a 'running' lease is still within its TTL, when a
 * 'failed' lease is still backing off, or when the rollout is retired
 * (holder='retired', expiresAt=0).
 *
 * Idempotency: when `idempotencyToken` is provided AND a lease row
 * exists with the same rollout_id + claimed_by + idempotency_token,
 * the PRIOR token is returned unchanged and no row is modified
 * (protects retried HTTP calls from minting divergent tokens).
 *
 * The source version snapshot (source_updated_at / source_content_hash)
 * is captured from rollout_catalog at acquire time; throws when the
 * rollout has no catalog row (nothing to extract).
 */
export function acquireLease(
  db: Database,
  input: {
    rolloutId: string;
    claimedBy: string;
    ttlMs?: number;
    idempotencyToken?: string;
    now?: number;
  }
): AcquireResult {
  const { rolloutId, claimedBy } = input;
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = input.now ?? Date.now();

  const txn = db.transaction((): AcquireResult => {
    // 1. Permanent retirement is a hard exclusion.
    const retired = db
      .prepare('SELECT rollout_id FROM rollout_retired WHERE rollout_id = ?')
      .get(rolloutId) as { rollout_id: string } | undefined;
    if (retired) {
      return { status: 'busy', holder: 'retired', expiresAt: 0 };
    }

    // 2. Source snapshot comes from the catalog (Plan 301); the lease
    //    stores it so complete() can CAS against source drift.
    const catalog = db
      .prepare('SELECT last_message_at, source_fingerprint FROM rollout_catalog WHERE rollout_id = ?')
      .get(rolloutId) as CatalogSnapshotRow | undefined;
    if (!catalog) {
      throw new Error(`rollout not in catalog: ${rolloutId}`);
    }
    const sourceUpdatedAt = catalog.last_message_at ?? 0;
    const sourceContentHash = catalog.source_fingerprint ?? '';

    const row = db
      .prepare('SELECT * FROM rollout_leases WHERE rollout_id = ?')
      .get(rolloutId) as RolloutLeaseRow | undefined;

    // 3. Explicit idempotency: same holder + same token returns the
    //    prior token untouched.
    if (
      row &&
      input.idempotencyToken !== undefined &&
      row.claimed_by === claimedBy &&
      row.idempotency_token === input.idempotencyToken
    ) {
      return { status: 'acquired', token: row.token, expiresAt: row.expires_at };
    }

    // 4. Fresh insert.
    if (!row) {
      const token = randomUUID();
      db.prepare(
        `INSERT INTO rollout_leases (
           rollout_id, token, acquired_at, heartbeat_at, expires_at,
           attempt_count, next_retry_at, claimed_by, idempotency_token,
           last_error, source_updated_at, source_content_hash, job_status
         ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, 'running')`
      ).run(
        rolloutId,
        token,
        now,
        now,
        now + ttlMs,
        claimedBy,
        input.idempotencyToken ?? null,
        sourceUpdatedAt,
        sourceContentHash
      );
      return { status: 'acquired', token, expiresAt: now + ttlMs };
    }

    // 5. Live running lease → busy.
    if (row.job_status === 'running' && row.expires_at > now) {
      return { status: 'busy', holder: row.claimed_by, expiresAt: row.expires_at };
    }

    // Failed lease still backing off → busy (retry time as expiresAt).
    if (row.job_status === 'failed' && row.next_retry_at !== null && row.next_retry_at > now) {
      return { status: 'busy', holder: row.claimed_by, expiresAt: row.next_retry_at };
    }

    // 6-8. Re-acquirable: expired running, backoff-elapsed failed, or
    // reclaiming. INSERT OR REPLACE bumps attempt_count and resets the
    // per-attempt fields (fresh token, NULL next_retry_at/last_error).
    const token = randomUUID();
    db.prepare(
      `INSERT OR REPLACE INTO rollout_leases (
         rollout_id, token, acquired_at, heartbeat_at, expires_at,
         attempt_count, next_retry_at, claimed_by, idempotency_token,
         last_error, source_updated_at, source_content_hash, job_status
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, 'running')`
    ).run(
      rolloutId,
      token,
      now,
      now,
      now + ttlMs,
      row.attempt_count + 1,
      claimedBy,
      input.idempotencyToken ?? null,
      sourceUpdatedAt,
      sourceContentHash
    );
    return { status: 'acquired', token, expiresAt: now + ttlMs };
  });

  return txn.immediate();
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

/**
 * Extend the lease. Returns true when the heartbeat was applied; false
 * means the lease was lost (reclaimed by another process, expired, or
 * no longer running) and the caller MUST abort its work.
 */
export function heartbeat(
  db: Database,
  input: {
    rolloutId: string;
    token: string;
    ttlMs?: number;
    now?: number;
  }
): boolean {
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = input.now ?? Date.now();

  const result = db
    .prepare(
      `UPDATE rollout_leases
         SET heartbeat_at = ?, expires_at = ?
       WHERE rollout_id = ? AND token = ? AND job_status = 'running'`
    )
    .run(now, now + ttlMs, input.rolloutId, input.token);

  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// complete (CAS)
// ---------------------------------------------------------------------------

export type CompleteStatus =
  | 'committed'
  | 'stale_lease' // no running lease row for (rollout_id, token)
  | 'stale_worker' // heartbeat_at older than STALE_WORKER_GRACE_MS (worker abandoned)
  | 'source_changed'; // caller version ≠ lease snapshot, or catalog row gone

interface CatalogMappingRow {
  project_id: string | null;
  working_directory: string | null;
}

/**
 * Complete a leased extraction with compare-and-swap guards.
 *
 * On 'committed': UPSERTs the stage1_outputs row and DELETEs the lease
 * in one BEGIN IMMEDIATE transaction. On any stale status NOTHING is
 * written — the caller must discard its result.
 *
 * CAS layers (in order):
 *   1. a running lease row must exist for (rollout_id, token)
 *      → 'stale_lease'
 *   2. heartbeat freshness: heartbeat_at >= now - STALE_WORKER_GRACE_MS
 *      → 'stale_worker'
 *   3. caller-supplied source version must equal the lease snapshot
 *      → 'source_changed'
 *   4. the rollout_catalog row must still exist → 'source_changed'
 *
 * `extracted_through_seq` and `content_hash_at_write` are supplied by
 * Plan 304 via the optional `extractedThroughSeq` / `contentHashAtWrite`
 * inputs (both default to NULL when omitted, preserving the Plan 302
 * behavior for callers that do not track them yet).
 */
export function complete(
  db: Database,
  input: {
    rolloutId: string;
    token: string;
    sourceUpdatedAt: number; // ms; must match the lease snapshot
    sourceContentHash: string;
    outcome: Stage1JobStatus;
    contentOutcome: ContentOutcome | null;
    rolloutSummary: string | null;
    rawMemoryJson: string | null;
    rolloutSlug: string;
    extractedThroughSeq?: number | null; // Plan 304: high-water mark of extracted source seq
    contentHashAtWrite?: string | null; // Plan 304: sha256 of the projection file at write time
    stage1PolicyVersion?: number | null; // Plan 405: Stage 1 policy version
    stage1PolicyHash?: string | null;     // Plan 405: sha256 of stage1_policy.md content
    schemaVersion?: number; // default 2
    now?: number;
  }
): CompleteStatus {
  const { rolloutId, token } = input;
  const now = input.now ?? Date.now();

  // succeeded_no_output is a first-class terminal state (D2): content
  // fields persist as NULL and block re-extraction while the source is
  // unchanged.
  const noOutput = input.outcome === 'succeeded_no_output';
  const contentOutcome = noOutput ? null : input.contentOutcome;
  const rolloutSummary = noOutput ? null : input.rolloutSummary;
  const rawMemory = noOutput ? null : input.rawMemoryJson;

  const txn = db.transaction((): CompleteStatus => {
    const lease = db
      .prepare(
        `SELECT * FROM rollout_leases
         WHERE rollout_id = ? AND token = ? AND job_status = 'running'`
      )
      .get(rolloutId, token) as RolloutLeaseRow | undefined;
    if (!lease) {
      return 'stale_lease';
    }

    if (lease.heartbeat_at < now - STALE_WORKER_GRACE_MS) {
      return 'stale_worker';
    }

    if (
      lease.source_updated_at !== input.sourceUpdatedAt ||
      lease.source_content_hash !== input.sourceContentHash
    ) {
      return 'source_changed';
    }

    const catalog = db
      .prepare('SELECT project_id, working_directory FROM rollout_catalog WHERE rollout_id = ?')
      .get(rolloutId) as CatalogMappingRow | undefined;
    if (!catalog) {
      return 'source_changed';
    }

    db.prepare(
      `INSERT INTO stage1_outputs (
         rollout_id, thread_id, cwd, project_id, git_branch,
         job_status, content_outcome, rollout_summary, raw_memory,
         rollout_slug, generated_at, source_updated_at, source_content_hash,
         extracted_through_seq, output_updated_at, schema_version,
         content_hash_at_write,
         stage1_policy_version, stage1_policy_hash
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rollout_id) DO UPDATE SET
         job_status = excluded.job_status,
         content_outcome = excluded.content_outcome,
         rollout_summary = excluded.rollout_summary,
         raw_memory = excluded.raw_memory,
         rollout_slug = excluded.rollout_slug,
         generated_at = excluded.generated_at,
         source_updated_at = excluded.source_updated_at,
         source_content_hash = excluded.source_content_hash,
         extracted_through_seq = excluded.extracted_through_seq,
         output_updated_at = excluded.output_updated_at,
         content_hash_at_write = excluded.content_hash_at_write,
         stage1_policy_version = excluded.stage1_policy_version,
         stage1_policy_hash = excluded.stage1_policy_hash`
    ).run(
      rolloutId,
      rolloutId, // thread_id
      catalog.working_directory ?? '',
      GLOBAL_PROJECT_ID,
      input.outcome,
      contentOutcome,
      rolloutSummary,
      rawMemory,
      input.rolloutSlug,
      now, // generated_at
      lease.source_updated_at,
      lease.source_content_hash,
      input.extractedThroughSeq ?? null,
      now, // output_updated_at
      input.schemaVersion ?? 2,
      input.contentHashAtWrite ?? null,
      input.stage1PolicyVersion ?? null,
      input.stage1PolicyHash ?? null
    );

    db.prepare('DELETE FROM rollout_leases WHERE rollout_id = ? AND token = ?').run(rolloutId, token);

    return 'committed';
  });

  return txn.immediate();
}

// ---------------------------------------------------------------------------
// fail (backoff + retire)
// ---------------------------------------------------------------------------

/**
 * Mark the leased attempt as failed and schedule the next retry per
 * the backoff schedule. When attempt_count reaches MAX_RETRY_ATTEMPTS
 * the rollout is permanently retired: the failure history moves to
 * rollout_retired and the lease row is deleted (no further acquire).
 *
 * Silent no-op when no lease row matches (rollout_id, token) — the
 * lease was already lost or completed. attempt_count is NOT bumped
 * here; it advances on re-acquire.
 */
export function fail(
  db: Database,
  input: {
    rolloutId: string;
    token: string;
    error: string;
    now?: number;
  }
): void {
  const { rolloutId, token, error } = input;
  const now = input.now ?? Date.now();

  const txn = db.transaction(() => {
    const lease = db
      .prepare('SELECT * FROM rollout_leases WHERE rollout_id = ? AND token = ?')
      .get(rolloutId, token) as RolloutLeaseRow | undefined;
    if (!lease) {
      return; // lease already lost or completed — nothing to fail
    }

    if (lease.attempt_count >= MAX_RETRY_ATTEMPTS) {
      db.prepare(
        `INSERT INTO rollout_retired (rollout_id, attempt_count, last_error, retired_at)
         VALUES (?, ?, ?, ?)`
      ).run(rolloutId, lease.attempt_count, error, now);
      db.prepare('DELETE FROM rollout_leases WHERE rollout_id = ? AND token = ?').run(rolloutId, token);
      return;
    }

    const backoff = backoffMs(lease.attempt_count);
    // attempt_count < MAX_RETRY_ATTEMPTS guarantees a non-null backoff.
    db.prepare(
      `UPDATE rollout_leases
         SET job_status = 'failed', next_retry_at = ?, last_error = ?
       WHERE rollout_id = ? AND token = ?`
    ).run(now + (backoff as number), error, rolloutId, token);
  });

  txn.immediate();
}
