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

export type AgentType = 'main' | 'sub-agent' | 'gateway' | 'automation' | 'research' | 'conductor';

export type SourceStatus = 'active' | 'deleted' | 'missing';

export interface ProjectRow {
  project_id: string;
  canonical_root: string;
  created_at: number;
  last_seen_at: number;
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
