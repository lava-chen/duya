import * as crypto from 'crypto';

/**
 * Migration 0007: Lifecycle fields and expanded scope on memory_entries.
 *
 * Adds lifecycle metadata columns used by the consolidation pipeline to
 * reason about temporal validity, supersession chains, and retrieval:
 *
 *   - confidence                   — confidence level of the entry (nullable)
 *   - valid_from                   — ISO-8601 date the entry becomes valid
 *   - valid_until                  — ISO-8601 date the entry expires
 *   - relation_to_existing         — how this entry relates to an existing one
 *   - supersedes                   — JSON array string of superseded memory_ids
 *   - why_future_agent_needs_this  — justification for long-term retention
 *   - retrieval_cues               — JSON array string of retrieval cues
 *   - scope_id                     — sub-scope identifier (e.g. repo, app,
 *                                    relationship id) within a scope value
 *
 * Expands the CHECK constraints:
 *   - kind:   preference, fact, decision, invariant, procedure, goal,
 *             commitment, reference, person, relationship, area, capability
 *   - scope:  personal, project, repository, app, relationship, shared,
 *             global
 *   - status: active, superseded, retired, draft
 *
 * SQLite cannot ALTER a CHECK constraint in place, so this migration
 * rebuilds `memory_entries` with the expanded schema. Existing rows are
 * preserved verbatim via INSERT...SELECT; the new lifecycle columns are
 * NULL for pre-existing rows. The unique index now includes scope_id via
 * COALESCE so rows with different sub-scope identifiers do not collide
 * on the same canonical key.
 */
const SQL = `
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
  ON memory_entries(scope, COALESCE(scope_id, ''), COALESCE(project_id, ''), canonical_key);
`;

export const migration0007 = {
  version: 7,
  name: 'lifecycle_scope',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
