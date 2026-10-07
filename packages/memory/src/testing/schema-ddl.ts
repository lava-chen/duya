/**
 * packages/agent/src/memory-state/__tests__/schema-ddl.ts
 *
 * The memory-state schema the agent's memory-state modules REQUIRE, as DDL.
 *
 * ## Why this file exists
 *
 * `memory-state.db` is host-owned durable state: its schema is created and
 * versioned by `apps/desktop/src/main/memory-state/migrations`, which the
 * architecture inventory classifies `cp-durable`. The agent package used to
 * reach into those host migration files by RELATIVE PATH from this test
 * fixture, which is 14 of the 15 `pkg:agent -> electron-main` value edges the
 * M5.1 cut list ranked first.
 *
 * Those modules are readers and writers of tables the HOST creates, so the
 * agent's requirement on the schema is a real, ownable contract: this file is
 * that requirement, stated as DDL, and `fixture.ts` materialises it.
 *
 * ## Why a copy and not an import
 *
 * Importing the host migrations is what created the edge. Copying them ends it
 * and keeps the direction correct (host owns the schema; the agent states what
 * it needs of it). The cost of a copy is drift, so drift is pinned instead:
 * `apps/desktop/src/main/memory-state/__tests__/agent-fixture-drift.test.ts`
 * is the owner of the schema and asserts this DDL still matches its migrations.
 * A change to a host migration that this file does not track fails there.
 *
 * NOT a re-export: nothing in `packages/agent` imports the host to get this.
 */

/**
 * The statements a memory-state fixture applies, in host migration order.
 *
 * Concatenation order matters (0002 ALTERs what 0001 creates) and matches the
 * order the host runner applies, which is what the drift test compares.
 */
export const MEMORY_STATE_FIXTURE_DDL: readonly string[] = [
  `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE project_path_aliases (
  project_id TEXT NOT NULL,
  absolute_normalized_path TEXT NOT NULL,
  relative_path TEXT,
  alias_kind TEXT NOT NULL CHECK (alias_kind IN
    ('workspace_override','working_directory','git_root','cwd')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (absolute_normalized_path)
);
CREATE INDEX idx_project_path_aliases_id
  ON project_path_aliases(project_id);

CREATE TABLE rollout_catalog (
  rollout_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','project')),
  project_id TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN
    ('main','sub-agent','gateway','automation','research','conductor')),
  parent_id TEXT,
  mode TEXT,
  working_directory TEXT,
  working_directory_normalized TEXT,
  git_root TEXT,
  agent_profile_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_message_at INTEGER,
  source_status TEXT NOT NULL DEFAULT 'active'
    CHECK (source_status IN ('active','deleted','missing')),
  source_missing_at INTEGER,
  source_deleted_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  source_fingerprint TEXT,
  last_seen_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (scope_kind = 'global' AND project_id IS NULL)
    OR
    (scope_kind = 'project' AND project_id IS NOT NULL)
  )
);
CREATE INDEX idx_rollout_catalog_scope
  ON rollout_catalog(scope_kind, project_id, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_agent_type
  ON rollout_catalog(agent_type, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_status
  ON rollout_catalog(source_status, last_message_at DESC);`,
  `
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
CREATE INDEX idx_stage1_outputs_source_ver  ON stage1_outputs(source_updated_at);`,
  `
CREATE TABLE projection_outbox (
  projection_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_path           TEXT NOT NULL,
  operation             TEXT NOT NULL CHECK (operation IN ('write','delete')),
  content               TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER,
  last_error            TEXT,
  enqueued_at           INTEGER NOT NULL,
  completed_at          INTEGER
);
CREATE INDEX idx_outbox_pending ON projection_outbox(completed_at, next_attempt_at);

ALTER TABLE stage1_outputs ADD COLUMN content_hash_at_write TEXT;`,
  `
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
);`,
  `
CREATE TABLE memory_entries_new (
  memory_id             TEXT PRIMARY KEY,
  scope                 TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id            TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('preference','fact','reference','procedure','person','area')),
  canonical_key         TEXT NOT NULL,
  content               TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

INSERT INTO memory_entries_new (memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at)
  SELECT memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at
  FROM memory_entries;

DROP TABLE memory_entries;

ALTER TABLE memory_entries_new RENAME TO memory_entries;

CREATE UNIQUE INDEX idx_memory_entries_canonical
  ON memory_entries(scope, COALESCE(project_id, ''), canonical_key);`,
  `
CREATE TABLE memory_entries_new (
  memory_id                     TEXT PRIMARY KEY,
  scope                         TEXT NOT NULL CHECK (scope IN ('personal','project','repository','app','relationship','shared','global')),
  project_id                    TEXT,
  kind                          TEXT NOT NULL CHECK (kind IN ('preference','fact','decision','invariant','procedure','goal','commitment','reference','person','relationship','area','capability')),
  canonical_key                 TEXT NOT NULL,
  content                       TEXT NOT NULL,
  version                       INTEGER NOT NULL DEFAULT 1,
  status                        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired','draft')),
  confidence                    TEXT,
  valid_from                    TEXT,
  valid_until                   TEXT,
  relation_to_existing          TEXT,
  supersedes                    TEXT,
  why_future_agent_needs_this   TEXT,
  retrieval_cues                TEXT,
  scope_id                      TEXT,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

INSERT INTO memory_entries_new (memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at)
  SELECT memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at
  FROM memory_entries;

DROP TABLE memory_entries;

ALTER TABLE memory_entries_new RENAME TO memory_entries;

CREATE UNIQUE INDEX idx_memory_entries_canonical
  ON memory_entries(scope, COALESCE(scope_id, ''), COALESCE(project_id, ''), canonical_key);`,
  `
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
CREATE INDEX idx_curation_run_inputs_key    ON curation_run_inputs(input_kind, input_key, content_hash);`,
];

/** Every fixture statement as one script, for the drift comparison. */
export const MEMORY_STATE_FIXTURE_SQL: string = MEMORY_STATE_FIXTURE_DDL.join('\n');
