import * as crypto from 'crypto';

/**
 * Migration 0008: Curation run ledger + staging support (Memory Phase 2 redesign).
 *
 * Creates:
 *   - curation_runs         (one row per curation/rollback run; replaces phase2_runs)
 *   - curation_run_inputs   (which exact input versions a run consumed + disposition)
 *   - curation_publications (publication journal mirror for audit queries)
 *
 * Alters:
 *   - stage1_outputs +stage1_policy_version INTEGER
 *   - stage1_outputs +stage1_policy_hash    TEXT
 *
 * The old phase2_runs table (migration 0005) is NOT dropped here; it is
 * retired in Phase D (migration 0012). Both tables coexist so the old
 * consolidator keeps running during the shadow dual-run phase.
 *
 * See design doc §3.2 for the full schema rationale.
 */
const SQL = `
CREATE TABLE curation_runs (
  run_id              TEXT PRIMARY KEY,
  run_type            TEXT NOT NULL DEFAULT 'curation'
                        CHECK (run_type IN ('curation','rollback')),
  parent_run_id       TEXT,
  retry_group_id      TEXT,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','succeeded','failed','abandoned')),
  publication_status  TEXT NOT NULL DEFAULT 'pending'
                        CHECK (publication_status IN
                          ('pending','prepared','publishing','filesystem_committed','succeeded','failed')),
  cache_status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (cache_status IN ('pending','ok','cache_pending','failed')),
  input_set_hash      TEXT NOT NULL,
  base_manifest_hash  TEXT NOT NULL,
  lock_token          TEXT NOT NULL,
  claimed_by          TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  heartbeat_at        INTEGER NOT NULL,
  lease_expires_at    INTEGER NOT NULL,
  finished_at         INTEGER,
  attempt_count       INTEGER NOT NULL DEFAULT 1,
  next_retry_at       INTEGER,
  error               TEXT,
  FOREIGN KEY (parent_run_id) REFERENCES curation_runs(run_id)
);

CREATE TABLE curation_run_inputs (
  run_id              TEXT NOT NULL,
  input_kind          TEXT NOT NULL DEFAULT 'rollout'
                        CHECK (input_kind IN ('rollout','ad_hoc')),
  input_key           TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  output_updated_at   INTEGER NOT NULL,
  disposition         TEXT,
  deferred_until      INTEGER,
  note                TEXT,
  PRIMARY KEY (run_id, input_kind, input_key, content_hash),
  FOREIGN KEY (run_id) REFERENCES curation_runs(run_id)
);

CREATE TABLE curation_publications (
  run_id              TEXT PRIMARY KEY,
  generation          INTEGER NOT NULL,
  old_manifest_hash   TEXT NOT NULL,
  new_manifest_hash   TEXT NOT NULL,
  old_policy_version  INTEGER,
  new_policy_version  INTEGER,
  old_layout_version  INTEGER,
  new_layout_version  INTEGER,
  journal_path        TEXT NOT NULL,
  published_at        INTEGER NOT NULL
);

ALTER TABLE stage1_outputs ADD COLUMN stage1_policy_version INTEGER;
ALTER TABLE stage1_outputs ADD COLUMN stage1_policy_hash TEXT;

CREATE INDEX idx_curation_runs_status       ON curation_runs(status);
CREATE INDEX idx_curation_runs_lease        ON curation_runs(lease_expires_at);
CREATE INDEX idx_curation_runs_retry_group  ON curation_runs(retry_group_id);
CREATE INDEX idx_curation_run_inputs_key    ON curation_run_inputs(input_kind, input_key, content_hash);
`;

export const migration0008 = {
  version: 8,
  name: 'curation_runs',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};