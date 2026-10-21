import * as crypto from 'crypto';

/**
 * Migration 0010: Bot memory tier index (Plan 479 Phase 1, P1.0 hybrid decision).
 *
 * Plan 479 §6.1 chose the hybrid layout: tier attribution lives in the
 * file manifest (directory structure + frontmatter — the files remain the
 * source of truth), while this table is a rebuildable QUERY INDEX over
 * that tree so per-turn prompt rendering can do by-tier / by-shard /
 * merged-recall queries without scanning the filesystem every turn.
 *
 * Layout decided by P1.0 (recorded in plan 479 §6.1):
 *   - tier='agent'   → `<duyaRoot>/agents/<agentId>/memory/` (Plan 485
 *                      reservation; dir-based option chosen)
 *   - tier='user'    → `<duyaRoot>/memory/` tree (existing items/ +
 *                      entities/ + global/ backfilled as legacy user tier)
 *   - tier='project' → `<duyaRoot>/memory/projects/...` (Phase 3 write side)
 *
 * Column semantics:
 *   - entry_id: deterministic — sha256 of `tier|agent_profile_id|project_id|
 *     dedupe_key`. Stable across file moves; the upsert conflict target.
 *   - agent_profile_id: own-tier owner / shared-layer writer. '' = legacy
 *     user-tier rows (writer unknown). NOT NULL '' (not NULL) so shard
 *     queries and the unique index need no COALESCE.
 *   - project_id: project tier scope; '' otherwise.
 *   - kind: grok triad 'profile' | 'log' | 'note' (§3.1). Episodes are log
 *     entries with an `[episode]` dedupe-key prefix — no separate kind.
 *   - dedupe_key: application-normalized (trim + lowercase). The CHECK
 *     constraint enforces the lowercase invariant at the DB level so an
 *     un-normalized write fails loudly instead of silently duplicating.
 *   - file_path: duya-root-relative with forward slashes, unique — one
 *     entry = one markdown file (mirrors the canonical file model).
 *   - content_hash: sha256 of file bytes at index time (frozen-snapshot
 *     content key input for Plan 479 Phase 2 / Plan 474 dual-key cache).
 *   - created_at / updated_at: epoch ms; newest-wins comparator.
 *
 * Rebuildable: the source of truth is the file tree; losing or
 * emptying this table is recoverable via rebuildTierIndexFromFiles.
 * Do not modify this migration after release — add 0011+ instead.
 */
const SQL = `
CREATE TABLE memory_tier_index (
  entry_id         TEXT PRIMARY KEY,
  tier             TEXT NOT NULL CHECK (tier IN ('agent','user','project')),
  agent_profile_id TEXT NOT NULL DEFAULT '',
  project_id       TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL CHECK (kind IN ('profile','log','note')),
  dedupe_key       TEXT NOT NULL CHECK (dedupe_key = lower(dedupe_key) AND dedupe_key = trim(dedupe_key)),
  file_path        TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_memory_tier_file ON memory_tier_index(file_path);
CREATE UNIQUE INDEX idx_memory_tier_shard_dedupe
  ON memory_tier_index(tier, agent_profile_id, project_id, dedupe_key);
CREATE INDEX idx_memory_tier_tier  ON memory_tier_index(tier);
CREATE INDEX idx_memory_tier_shard ON memory_tier_index(tier, agent_profile_id);
`;

export const migration0010 = {
  version: 10,
  name: 'memory_tier_index',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
