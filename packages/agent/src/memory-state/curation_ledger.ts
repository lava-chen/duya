import { randomUUID, createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Curation run ledger (Memory Phase 2 redesign, design §3.2 + §8.4).
 *
 * Tracks which inputs (rollout_id, source_content_hash pairs) have been
 * consumed by which curation run, with a lease model mirroring lease.ts.
 *
 * Every public function takes the DB handle as its first parameter so
 * packages/agent does not import the Electron DB singleton.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputKind = 'rollout' | 'ad_hoc';
export type CurationRunStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';
export type PublicationStatus =
  | 'pending'
  | 'prepared'
  | 'publishing'
  | 'filesystem_committed'
  | 'succeeded'
  | 'failed';
export type CacheStatus = 'pending' | 'ok' | 'cache_pending' | 'failed';
export type Disposition = 'absorbed' | 'no_change' | 'rejected' | 'deferred';

export interface CurationInput {
  inputKind: InputKind;
  inputKey: string;
  contentHash: string;
  outputUpdatedAt: number;
}

export interface EligibleInput extends CurationInput {
  rolloutSlug: string;
  bytes: number;
}

export interface InputDisposition {
  inputKind: InputKind;
  inputKey: string;
  contentHash: string;
  disposition: Disposition;
  note?: string;
  deferredUntil?: number | null;
}

// ---------------------------------------------------------------------------
// computeInputSetHash (pure, exported for caller use + testing)
// ---------------------------------------------------------------------------

/**
 * Compute the input_set_hash: sha256 of sorted (input_key, content_hash)
 * pairs. Deterministic regardless of input array order.
 */
export function computeInputSetHash(
  inputs: Array<{ inputKey: string; contentHash: string }>
): string {
  const sorted = [...inputs].sort((a, b) => {
    const cmp = a.inputKey.localeCompare(b.inputKey);
    return cmp !== 0 ? cmp : a.contentHash.localeCompare(b.contentHash);
  });
  const payload = sorted.map((i) => `${i.inputKey}\0${i.contentHash}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// claimRun
// ---------------------------------------------------------------------------

export interface ClaimRunInput {
  inputSetHash: string;
  baseManifestHash: string;
  claimedBy: string;
  leaseTtlMs: number;
  inputs: CurationInput[];
  now?: number;
  runId?: string;
  lockToken?: string;
}

export interface ClaimRunResult {
  runId: string;
  lockToken: string;
}

/**
 * Atomically claim a batch of inputs for a new curation run.
 *
 * BEGIN IMMEDIATE → single-flight check (rejects if another run has a
 * non-expired lease) → INSERT curation_runs + curation_run_inputs → COMMIT.
 *
 * Throws when a curation run is already in flight (status='running' with
 * lease_expires_at > now). The caller must retry on the next tick.
 */
export function claimRun(db: Database, input: ClaimRunInput): ClaimRunResult {
  const now = input.now ?? Date.now();
  const runId = input.runId ?? randomUUID();
  const lockToken = input.lockToken ?? randomUUID();
  const leaseExpiresAt = now + input.leaseTtlMs;

  const txn = db.transaction((): ClaimRunResult => {
    // Single-flight: reject if another run holds a non-expired lease.
    const inFlight = db
      .prepare(
        `SELECT run_id FROM curation_runs
         WHERE status = 'running' AND lease_expires_at > ?`
      )
      .get(now) as { run_id: string } | undefined;
    if (inFlight) {
      throw new Error(`curation run already in flight: ${inFlight.run_id}`);
    }

    db.prepare(
      `INSERT INTO curation_runs (
         run_id, run_type, status, publication_status, cache_status,
         input_set_hash, base_manifest_hash, lock_token, claimed_by,
         started_at, heartbeat_at, lease_expires_at, attempt_count
       ) VALUES (?, 'curation', 'running', 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      runId,
      input.inputSetHash,
      input.baseManifestHash,
      lockToken,
      input.claimedBy,
      now,
      now,
      leaseExpiresAt
    );

    const insertInput = db.prepare(
      `INSERT INTO curation_run_inputs (
         run_id, input_kind, input_key, content_hash, output_updated_at
       ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const inp of input.inputs) {
      insertInput.run(runId, inp.inputKind, inp.inputKey, inp.contentHash, inp.outputUpdatedAt);
    }

    return { runId, lockToken };
  });

  return txn.immediate();
}

// ---------------------------------------------------------------------------
// completeRun
// ---------------------------------------------------------------------------

export interface CompleteRunInput {
  dispositions: InputDisposition[];
  publicationStatus: PublicationStatus;
  now?: number;
}

/**
 * Mark a curation run as succeeded and record per-input dispositions.
 *
 * BEGIN IMMEDIATE → verify run exists and is 'running' → UPDATE run
 * status='succeeded' + UPDATE each input disposition → COMMIT.
 *
 * Throws if the run does not exist or is not in 'running' state.
 */
export function completeRun(db: Database, runId: string, input: CompleteRunInput): void {
  const now = input.now ?? Date.now();

  const txn = db.transaction(() => {
    const run = db
      .prepare('SELECT status FROM curation_runs WHERE run_id = ?')
      .get(runId) as { status: string } | undefined;
    if (!run) {
      throw new Error(`curation run not found: ${runId}`);
    }
    if (run.status !== 'running') {
      throw new Error(`curation run ${runId} is not running (status=${run.status})`);
    }

    db.prepare(
      `UPDATE curation_runs
         SET status = 'succeeded',
             publication_status = ?,
             cache_status = 'ok',
             finished_at = ?
       WHERE run_id = ?`
    ).run(input.publicationStatus, now, runId);

    const updateInput = db.prepare(
      `UPDATE curation_run_inputs
         SET disposition = ?,
             deferred_until = ?,
             note = ?
       WHERE run_id = ? AND input_kind = ? AND input_key = ? AND content_hash = ?`
    );
    for (const d of input.dispositions) {
      updateInput.run(
        d.disposition,
        d.deferredUntil ?? null,
        d.note ?? null,
        runId,
        d.inputKind,
        d.inputKey,
        d.contentHash
      );
    }
  });

  txn.immediate();
}

// ---------------------------------------------------------------------------
// failRun
// ---------------------------------------------------------------------------

/**
 * Mark a curation run as failed. Inputs are NOT marked — they remain
 * eligible for a future run (design §11.1).
 *
 * Throws if the run does not exist.
 */
export function failRun(db: Database, runId: string, error: string, now?: number): void {
  const ts = now ?? Date.now();

  const txn = db.transaction(() => {
    const run = db
      .prepare('SELECT status FROM curation_runs WHERE run_id = ?')
      .get(runId) as { status: string } | undefined;
    if (!run) {
      throw new Error(`curation run not found: ${runId}`);
    }

    db.prepare(
      `UPDATE curation_runs
         SET status = 'failed',
             error = ?,
             finished_at = ?
       WHERE run_id = ?`
    ).run(error, ts, runId);
  });

  txn.immediate();
}

// ---------------------------------------------------------------------------
// renewLease
// ---------------------------------------------------------------------------

/**
 * Extend the lease on a running curation run. Returns true when the
 * renewal was applied; false means the lock_token did not match or the
 * run is not in 'running' state (the caller MUST abort its work).
 */
export function renewLease(
  db: Database,
  runId: string,
  lockToken: string,
  ttlMs: number,
  now?: number
): boolean {
  const ts = now ?? Date.now();

  const result = db
    .prepare(
      `UPDATE curation_runs
         SET heartbeat_at = ?,
             lease_expires_at = ?
       WHERE run_id = ? AND lock_token = ? AND status = 'running'`
    )
    .run(ts, ts + ttlMs, runId, lockToken);

  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// queryEligibleInputs
// ---------------------------------------------------------------------------

export interface QueryEligibleOpts {
  maxInputs: number;
  maxInputBytes: number;
  now?: number;
}

interface EligibleRow {
  rollout_id: string;
  source_content_hash: string;
  output_updated_at: number;
  rollout_slug: string;
  bytes: number;
}

/**
 * Query stage1_outputs for inputs eligible for curation (design §3.3).
 *
 * An input is eligible when ALL of:
 *   - stage1_outputs.job_status = 'succeeded'
 *   - No curation_run_inputs row with disposition IN ('absorbed','no_change',
 *     'rejected') exists on a succeeded run for the same (input_key, content_hash)
 *   - No deferred row with deferred_until > now exists
 *
 * Results are ordered by generated_at ASC (oldest first), then truncated
 * to maxInputs and maxInputBytes.
 */
export function queryEligibleInputs(db: Database, opts: QueryEligibleOpts): EligibleInput[] {
  const now = opts.now ?? Date.now();

  const rows = db
    .prepare(
      `SELECT
         s.rollout_id,
         s.source_content_hash,
         s.output_updated_at,
         s.rollout_slug,
         COALESCE(length(CAST(s.rollout_summary AS BLOB)), 0) AS bytes
       FROM stage1_outputs s
       WHERE s.job_status = 'succeeded'
         AND NOT EXISTS (
           SELECT 1 FROM curation_run_inputs cri
           JOIN curation_runs cr ON cr.run_id = cri.run_id
           WHERE cri.input_kind = 'rollout'
             AND cri.input_key = s.rollout_id
             AND cri.content_hash = s.source_content_hash
             AND cri.disposition IN ('absorbed','no_change','rejected')
             AND cr.status = 'succeeded'
         )
         AND NOT EXISTS (
           SELECT 1 FROM curation_run_inputs cri
           WHERE cri.input_kind = 'rollout'
             AND cri.input_key = s.rollout_id
             AND cri.content_hash = s.source_content_hash
             AND cri.disposition = 'deferred'
             AND cri.deferred_until > ?
         )
       ORDER BY s.generated_at ASC`
    )
    .all(now) as EligibleRow[];

  const result: EligibleInput[] = [];
  let totalBytes = 0;
  for (const row of rows) {
    if (result.length >= opts.maxInputs) break;
    if (totalBytes + row.bytes > opts.maxInputBytes) break;
    result.push({
      inputKind: 'rollout',
      inputKey: row.rollout_id,
      contentHash: row.source_content_hash,
      outputUpdatedAt: row.output_updated_at,
      rolloutSlug: row.rollout_slug,
      bytes: row.bytes,
    });
    totalBytes += row.bytes;
  }
  return result;
}