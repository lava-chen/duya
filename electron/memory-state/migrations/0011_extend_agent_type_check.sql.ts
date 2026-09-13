import * as crypto from 'crypto';

/**
 * Migration 0011: Extend rollout_catalog.agent_type CHECK constraint.
 *
 * Two agent_type values were introduced after migration 0001 and never
 * received a schema migration:
 *
 *   - 'spawn'  — Plan 504 (session-tool): child sessions spawned via
 *                `spawn:` prefix in SessionStore + db-bridge.ts:427.
 *                Enters the normal memory pipeline (Stage 1 extraction,
 *                curation, projection, rollouts). Blocked since 504
 *                landed because the CHECK rejected it → session_sync
 *                errors logged every 60s but swallowed by errors++.
 *
 *   - 'bot'    — Plan 493 Phase A: bot sessions stamped 'bot' in
 *                message-log.ts:2064 when first rollout path is written.
 *                Kept out of the catalog via bypass in catalogSync.ts
 *                (Plan 479 decision: bot memory fed by update_state
 *                tier writes, not Stage 1 extraction). The bypass is
 *                removed so CHECK and TypeScript types are consistent.
 *
 * SQLite does not support ALTER TABLE ADD CONSTRAINT, so this migration
 * renames the existing table, creates a new one with the extended CHECK,
 * migrates rows, then drops the backup.
 *
 * PK, indexes, and FK are preserved on the new table.
 */
const SQL = `
-- Step 1: rename the live table so we can re-create it with a tighter CHECK
ALTER TABLE rollout_catalog RENAME TO _rollout_catalog_backup;

-- Step 2: create new rollout_catalog with extended agent_type CHECK list
CREATE TABLE rollout_catalog (
  rollout_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','project')),
  project_id TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN
    ('main','sub-agent','gateway','automation','research','conductor','bot','spawn')),
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

-- Step 3: migrate existing rows (preserves all column values verbatim;
-- only the CHECK constraint is tightened by the new table definition).
INSERT OR ABORT INTO rollout_catalog
  SELECT * FROM _rollout_catalog_backup;

-- Step 4: clean up the backup. Its indexes (idx_rollout_catalog_scope /
-- _agent_type / _status) die with the table, freeing their names —
-- the old indexes survive an ALTER TABLE RENAME attached to the
-- backup table, so creating the new indexes before this DROP would
-- fail with "index ... already exists".
DROP TABLE _rollout_catalog_backup;

-- Step 5: restore indexes on the new table (must come after Step 4).
CREATE INDEX idx_rollout_catalog_scope
  ON rollout_catalog(scope_kind, project_id, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_agent_type
  ON rollout_catalog(agent_type, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_status
  ON rollout_catalog(source_status, last_message_at DESC);
`;

export const migration0011 = {
  version: 11,
  name: 'extend_agent_type_check',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
