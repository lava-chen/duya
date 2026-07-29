import * as crypto from 'crypto';

/**
 * Migration 0005: Phase 2 memory entities (Memory v2 Phase 2).
 *
 * Creates:
 *   - memory_entries       (canonical memory rows, scoped + versioned)
 *   - memory_evidence      (links memories to stage1 extraction items)
 *   - memory_usage_events  (retrieval / citation / influence telemetry)
 *   - phase2_runs          (rebuild / replay run bookkeeping)
 *
 * Does NOT create (owned by sibling plans):
 *   - projection_outbox + stage1_outputs.content_hash_at_write → Plan 303 (migration 0003)
 *
 * Migration 0004 was cancelled in design v3 revision #9 — version 4 is
 * intentionally skipped. New Phase 2 work continues at version 5.
 *
 * Important decisions baked into this schema (see Phase 2 design for
 * full rationale):
 *   - memory_entries.canonical_key is unique per (scope, project_id)
 *     via a partial-style index using COALESCE so global rows (NULL
 *     project_id) and per-project rows cannot collide on the same key.
 *   - memory_evidence uses (memory_id, stage1_item_id) as its PRIMARY
 *     KEY and WITHOUT ROWID for compactness — one evidence row per
 *     (memory, source item) pair.
 *   - memory_usage_events.classification_method defaults to 'pending'
 *     so async classification can backfill cited/influenced flags.
 *   - phase2_runs tracks each Phase 2 rebuild / replay run for
 *     auditability; lock_holder + status support the run coordinator.
 *   - Timestamps are INTEGER ms (matches the rest of the control plane).
 */
const SQL = `
CREATE TABLE memory_entries (
  memory_id             TEXT PRIMARY KEY,
  scope                 TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id            TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('preference','fact','reference','procedure')),
  canonical_key         TEXT NOT NULL,
  content               TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_entries_canonical ON memory_entries(scope, COALESCE(project_id, ''), canonical_key);

CREATE TABLE memory_evidence (
  memory_id             TEXT NOT NULL,
  rollout_id            TEXT NOT NULL,
  stage1_item_id        TEXT NOT NULL,
  relation              TEXT NOT NULL CHECK (relation IN ('source','supporting','counter','supersedes')),
  PRIMARY KEY (memory_id, stage1_item_id)
) WITHOUT ROWID;

CREATE TABLE memory_usage_events (
  event_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id             TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  retrieval_id          TEXT NOT NULL,
  retrieved_at          INTEGER NOT NULL,
  retrieved             INTEGER NOT NULL,
  cited                 INTEGER NOT NULL,
  influenced_answer     INTEGER NOT NULL,
  classification_method TEXT NOT NULL DEFAULT 'pending' CHECK (classification_method IN ('model_citation','parser','classifier','pending'))
);
CREATE INDEX idx_usage_memory     ON memory_usage_events(memory_id);
CREATE INDEX idx_usage_session    ON memory_usage_events(session_id);
CREATE INDEX idx_usage_retrieval  ON memory_usage_events(retrieval_id);

CREATE TABLE phase2_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  input_set_hash        TEXT NOT NULL,
  output_diff_summary   TEXT,
  lock_holder           TEXT,
  status                TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed'))
);
`;

export const migration0005 = {
  version: 5,
  name: 'phase2_entities',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
