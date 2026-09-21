import * as crypto from 'crypto';

/**
 * Migration 0012: Extend rollout_catalog.agent_type CHECK constraint
 * with 'room'.
 *
 * 'room' was introduced by Plan 478 (group-room transcript surface) via
 * `ensureRoomSession` in electron/wake/group-turn-dispatcher.ts:132, where
 * the room anchor session row gets `agentType: 'room'`. The constraint
 * added in migration 0011 did not include 'room', so the catalog sync
 * step (memory-state:catalogSync.syncAllFromMainDb) failed for every
 * room transcript, surfacing as a CHECK violation on every worker tick.
 *
 * Rooms never run an agent — they only anchor the MessageLog rollout
 * file and the source-filtered transcript reads. Keeping 'room' as a
 * distinct agent_type makes it easy to filter rooms out of any future
 * Stage 1 extraction without scanning ids.
 *
 * Same table-rename trick as 0011 — SQLite cannot ALTER CHECK.
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
    ('main','sub-agent','gateway','automation','research','conductor','bot','spawn','room')),
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

-- Step 3: migrate existing rows verbatim
INSERT OR ABORT INTO rollout_catalog
  SELECT * FROM _rollout_catalog_backup;

-- Step 4: drop the backup (frees the old index names)
DROP TABLE _rollout_catalog_backup;

-- Step 5: recreate indexes on the new table
CREATE INDEX idx_rollout_catalog_scope
  ON rollout_catalog(scope_kind, project_id, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_agent_type
  ON rollout_catalog(agent_type, last_message_at DESC);
CREATE INDEX idx_rollout_catalog_status
  ON rollout_catalog(source_status, last_message_at DESC);
`;

export const migration0012 = {
  version: 12,
  name: 'extend_agent_type_check_with_room',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};