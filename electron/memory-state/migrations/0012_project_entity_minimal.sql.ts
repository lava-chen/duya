import * as crypto from 'crypto';

/**
 * Migration 0012: Project entity minimal extension (Plan 525 Phase 1).
 *
 * Extends `projects` from a bare identity row into a nameable entity
 * and adds bot membership:
 *
 *   - projects.name         — display name (defaults to '')
 *   - projects.description  — one-line description (nullable)
 *   - projects.paths        — JSON array of {path, description} entries;
 *                             replaces the `project_path_aliases` table
 *                             as the source of truth once Plan 525
 *                             Phase 2 migrates the alias rows over
 *                             (the aliases table is dropped in Phase 2,
 *                             NOT here — resolver reads keep working
 *                             in the interim).
 *   - project_bots          — equal-membership join table (no role
 *                             column), PK (project_id, bot_id).
 *
 * Deliberately NOT here (Plan 525 §1.3 non-goals): no phase/goal/
 * deadline/owner columns, no role column, no alias_kind distinction.
 *
 * No FK on project_bots.bot_id: `agents` lives in duya-main.db while
 * this table lives in memory-state.db, and SQLite cannot enforce
 * cross-database foreign keys (referential integrity is maintained
 * at the application layer).
 */
const SQL = `
ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN description TEXT;
ALTER TABLE projects ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';

CREATE TABLE project_bots (
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, bot_id)
);
CREATE INDEX idx_project_bots_bot ON project_bots(bot_id);
`;

export const migration0012 = {
  version: 12,
  name: 'project_entity_minimal',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
