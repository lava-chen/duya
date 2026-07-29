import * as crypto from 'crypto';

/**
 * Migration 0006: Extend memory_entries.kind with 'person' and 'area'.
 *
 * The Stage 1 extractor and Phase 2 consolidator now extract two new
 * durable-knowledge dimensions alongside the original four claim types
 * (preference/fact/reference/procedure):
 *
 *   - person: a human the user mentions across sessions (colleagues,
 *     contacts, reviewers, etc.). Canonical key prefix: `person:`.
 *     Always global scope — people are not project-scoped.
 *   - area: a cross-project topic/domain the user works in (e.g.
 *     "frontend-build", "db-migration"). Canonical key prefix: `area:`.
 *     Always global scope — areas are by definition cross-project.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so this migration
 * rebuilds `memory_entries` with the expanded `kind` enum. Existing
 * rows are preserved verbatim via INSERT...SELECT *; the unique index
 * is recreated identically. `memory_evidence` has no FOREIGN KEY
 * constraint (only a logical reference via memory_id), so it is
 * unaffected by the rebuild.
 *
 * Projection files added by this change (rendered by Phase 2):
 *   - `global/people/<slug>.md` — one file per person entry.
 *   - `global/areas/<slug>.md`  — one file per area entry.
 *
 * These directories are scanned by `reconcile.ts` with orphan
 * detection: a file whose slug no longer matches any `memory_entries`
 * row with kind='person'/'area' is removed.
 */
const SQL = `
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
  ON memory_entries(scope, COALESCE(project_id, ''), canonical_key);
`;

export const migration0006 = {
  version: 6,
  name: 'people_areas_kinds',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
