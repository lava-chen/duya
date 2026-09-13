/**
 * TypeScript interfaces for the Memory control-plane schema.
 *
 * Row interfaces mirror the SQLite columns 1:1. Input interfaces
 * separate required-from-caller fields from DB-managed defaults so
 * insert helpers can fill in `created_at` / `last_seen_at` etc.
 *
 * Migration 0001 owns these tables. Plans 302-305 add more tables;
 * each migration has exactly one owner — see Plan 301 for the table
 * allocation matrix.
 */

export type AliasKind = 'workspace_override' | 'working_directory' | 'git_root' | 'cwd';

export type ScopeKind = 'global' | 'project';

export type AgentType = 'main' | 'sub-agent' | 'gateway' | 'automation' | 'research' | 'conductor' | 'bot' | 'spawn';

export type SourceStatus = 'active' | 'deleted' | 'missing';

export interface ProjectRow {
  project_id: string;
  canonical_root: string;
  /** Display name (migration 0012). Empty string when unset. */
  name: string;
  /** One-line description (migration 0012). NULL when unset. */
  description: string | null;
  /**
   * JSON-encoded array of {path, description} entries (migration 0012).
   * Parse with `parseProjectPaths` — never JSON.parse directly, so a
   * corrupted payload degrades to [] instead of throwing.
   */
  paths: string;
  /** Avatar icon name from the renderer icon registry (migration 0013). NULL = default. */
  icon: string | null;
  /** Avatar accent color, a palette keyword chosen in the create dialog (migration 0013). NULL = default. */
  color: string | null;
  created_at: number;
  last_seen_at: number;
}

/** One entry of the `projects.paths` JSON column (Plan 525 §2.4). */
export interface ProjectPathEntry {
  path: string;
  /** NULL when no description — never an empty string. */
  description: string | null;
}

export interface ProjectBotRow {
  project_id: string;
  /**
   * Plain TEXT — `agents` lives in duya-main.db so a real FK is
   * impossible across the two databases (migration 0012).
   */
  bot_id: string;
  joined_at: number;
}

export interface InsertProjectBotInput {
  project_id: string;
  bot_id: string;
  joined_at?: number;
}

/**
 * Parse the `projects.paths` JSON column.
 *
 * Corrupted or malformed payloads degrade to `[]` (Plan 525 §2.4) —
 * never throw, because a broken JSON blob must not take down project
 * resolution. Entries missing `path` or with a non-string path are
 * dropped; a missing/empty-string description is normalized to NULL.
 */
export function parseProjectPaths(raw: string | null | undefined): ProjectPathEntry[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ProjectPathEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, description } = item as Record<string, unknown>;
    if (typeof path !== 'string' || path === '') continue;
    entries.push({
      path,
      description: typeof description === 'string' && description !== '' ? description : null,
    });
  }
  return entries;
}

/**
 * Serialize `projects.paths` entries to the JSON column value.
 * Always produces a valid JSON array string (empty entries → '[]').
 */
export function serializeProjectPaths(entries: ProjectPathEntry[]): string {
  return JSON.stringify(entries);
}

export interface ProjectPathAliasRow {
  project_id: string;
  absolute_normalized_path: string;
  relative_path: string | null;
  alias_kind: AliasKind;
  first_seen_at: number;
  last_seen_at: number;
}

export interface RolloutCatalogRow {
  rollout_id: string;
  scope_kind: ScopeKind;
  project_id: string | null;
  agent_type: AgentType;
  parent_id: string | null;
  mode: string | null;
  working_directory: string | null;
  working_directory_normalized: string | null;
  git_root: string | null;
  agent_profile_id: string | null;
  message_count: number;
  last_message_id: string | null;
  last_message_at: number | null;
  source_status: SourceStatus;
  source_missing_at: number | null;
  source_deleted_at: number | null;
  generation: number;
  source_fingerprint: string | null;
  last_seen_at: number;
  first_seen_at: number;
}

export interface InsertProjectInput {
  project_id?: string;
  canonical_root: string;
  /** Optional since migration 0012 — DB defaults to ''. */
  name?: string;
  /** Optional since migration 0012 — DB defaults to NULL. */
  description?: string | null;
  /** Optional since migration 0012 — DB defaults to '[]'. Pre-serialized via serializeProjectPaths. */
  paths?: string;
  /** Optional since migration 0013 — DB defaults to NULL. */
  icon?: string | null;
  /** Optional since migration 0013 — DB defaults to NULL. */
  color?: string | null;
  created_at?: number;
  last_seen_at?: number;
}

export interface InsertProjectAliasInput {
  project_id: string;
  absolute_normalized_path: string;
  relative_path: string | null;
  alias_kind: AliasKind;
  first_seen_at?: number;
  last_seen_at?: number;
}

export interface UpsertRolloutCatalogInput {
  rollout_id: string;
  scope_kind: ScopeKind;
  project_id: string | null;
  agent_type: AgentType;
  parent_id: string | null;
  mode: string | null;
  working_directory: string | null;
  working_directory_normalized: string | null;
  git_root: string | null;
  agent_profile_id: string | null;
  message_count?: number;
  last_message_id: string | null;
  last_message_at: number | null;
  source_status?: SourceStatus;
  source_missing_at?: number | null;
  source_deleted_at?: number | null;
  generation?: number;
  source_fingerprint: string | null;
  last_seen_at?: number;
  first_seen_at?: number;
}
