import * as crypto from 'crypto';

/**
 * Migration 0002: Lease + Stage 1 output tables (Memory Phase 1A.2).
 *
 * Creates:
 *   - rollout_leases   (token + heartbeat + CAS lease lifecycle, D4)
 *   - rollout_retired  (permanent failure history; survives lease deletion)
 *   - stage1_outputs   (terminal extraction outputs + source version, D2/D3)
 *
 * Does NOT create (owned by sibling plans):
 *   - projection_outbox + stage1_outputs.content_hash_at_write → Plan 303 (migration 0003)
 *   - memory_entries / memory_evidence / memory_usage         → Phase 2  (migration 0005)
 *
 * Important decisions baked into this schema (see Plan 302 for full
 * rationale):
 *   - stage1_outputs.job_status deliberately excludes 'failed': execution
 *     failures live in rollout_leases (retryable) or rollout_retired
 *     (permanent); the outputs table only records successful LLM calls
 *     (design v3 D2).
 *   - rollout_leases stores the acquire-time source version
 *     (source_updated_at / source_content_hash) so complete() can CAS
 *     against source drift (D3/D4).
 *   - Timestamps are INTEGER ms (matches chat_sessions / messages).
 *   - content_hash_at_write is added by migration 0003 (ALTER); 0002 MUST
 *     be applied before 0003.
 */
const SQL = `
CREATE TABLE rollout_leases (
  rollout_id            TEXT PRIMARY KEY,
  token                 TEXT NOT NULL,
  acquired_at           INTEGER NOT NULL,
  heartbeat_at          INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 1,
  next_retry_at         INTEGER,
  claimed_by            TEXT NOT NULL,
  idempotency_token     TEXT,
  last_error            TEXT,
  source_updated_at     INTEGER NOT NULL,
  source_content_hash   TEXT NOT NULL,
  job_status            TEXT NOT NULL CHECK (job_status IN
                         ('running','failed','reclaiming'))
);

CREATE TABLE rollout_retired (
  rollout_id            TEXT PRIMARY KEY,
  attempt_count         INTEGER NOT NULL,
  last_error            TEXT,
  retired_at            INTEGER NOT NULL
);

CREATE TABLE stage1_outputs (
  rollout_id              TEXT PRIMARY KEY,
  thread_id               TEXT NOT NULL,
  cwd                     TEXT NOT NULL,
  project_id              TEXT NOT NULL,
  git_branch              TEXT,
  job_status              TEXT NOT NULL CHECK (job_status IN
                          ('succeeded','succeeded_no_output')),
  content_outcome         TEXT CHECK (content_outcome IN
                          ('success','partial','fail','uncertain')),
  rollout_summary         TEXT,
  raw_memory              TEXT,
  rollout_slug            TEXT NOT NULL,
  generated_at            INTEGER NOT NULL,
  source_updated_at       INTEGER NOT NULL,
  source_content_hash     TEXT NOT NULL,
  extracted_through_seq   INTEGER,
  output_updated_at       INTEGER NOT NULL,
  schema_version          INTEGER NOT NULL DEFAULT 2
);
CREATE INDEX idx_stage1_outputs_project     ON stage1_outputs(project_id);
CREATE INDEX idx_stage1_outputs_job_status  ON stage1_outputs(job_status);
CREATE INDEX idx_stage1_outputs_content_out ON stage1_outputs(content_outcome);
CREATE INDEX idx_stage1_outputs_source_ver  ON stage1_outputs(source_updated_at);
`;

export const migration0002 = {
  version: 2,
  name: 'lease_stage1',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
