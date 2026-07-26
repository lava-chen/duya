import * as crypto from 'crypto';

/**
 * Migration 0001: Initialize the Memory v2 control-plane schema.
 *
 * Creates:
 *   - projects             (stable UUID project identity)
 *   - project_path_aliases (normalized path → project_id lookup)
 *   - rollout_catalog      (one row per chat session, with source fingerprint)
 *
 * Does NOT create (owned by sibling plans):
 *   - rollout_leases / rollout_retired / stage1_outputs  → Plan 302 (migration 0002)
 *   - projection_outbox                                   → Plan 303 (migration 0003)
 *   - memory_entries / memory_evidence / memory_usage     → Phase 2  (migration 0005)
 *
 * The `memory_schema` bookkeeping table is created by the bootstrap
 * step in `migrations/index.ts`, NOT by this migration.
 *
 * Important decisions baked into this schema (see Plan 301 for full
 * rationale):
 *   - agent_type uses 'sub-agent' (with hyphen) to match the live
 *     value written by `packages/agent/src/tool/SubagentTool/SubagentTool.ts`.
 *     The CHECK list is a forward-looking superset; future agent kinds
 *     do not require a migration.
 *   - project_id is a UUID, not a path hash. Path is just an alias.
 *   - source_status is a tombstone enum, NOT a row delete — preserves
 *     provenance for memory entries that already cite deleted sessions.
 *   - scope_kind CHECK + nullable project_id enforces that global
 *     rollouts have NULL project_id and project rollouts have a valid FK.
 *   - Timestamps are INTEGER ms (matches chat_sessions / messages).
 */
const SQL = `
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
  ON rollout_catalog(source_status, last_message_at DESC);
`;

export const migration0001 = {
  version: 1,
  name: 'init_control_plane',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
