/**
 * queries/sessions.ts - Chat session SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * All functions operate on chat_sessions table.
 */

import { getDatabase } from '../connection';
import { resolvePermissionProfile } from '../permission-resolver';
import type { PermissionProfile } from '../../lib/permission-profile';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

function db(): BetterSqlite3 {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return d;
}

export interface SessionRow {
  id: string;
  title: string;
  model: string;
  system_prompt: string;
  working_directory: string;
  project_name: string;
  status: string;
  mode: string;
  permission_profile: string | null;
  provider_id: string;
  generation: number;
  context_summary: string | null;
  parent_id: string | null;
  agent_profile_id: string | null;
  agent_type: string;
  agent_name: string;
  conductor_mode_enabled: number;
  conductor_canvas_id: string | null;
  is_deleted: number;
  created_at: number;
  updated_at: number;
}

export interface CreateSessionInput {
  id: string;
  title?: string;
  model?: string;
  system_prompt?: string;
  working_directory?: string;
  project_name?: string;
  status?: string;
  mode?: string;
  provider_id?: string;
  generation?: number;
  parent_id?: string;
  parent_session_id?: string;
  agent_type?: string;
  agent_name?: string;
  permission_profile?: string;
  /**
   * trusted internal caller 才传 true. 普通 UI/IPC 不传.
   * 控制派生 session 显式 override 是否允许 (与 resolver 配合).
   */
  is_trusted_permission_override?: boolean;
  conductor_mode_enabled?: number;
  conductor_canvas_id?: string | null;
  created_at?: number;
  updated_at?: number;
}

export function createSession(data: CreateSessionInput): SessionRow {
  const now = Date.now();
  const createdAt = data.created_at ?? now;
  const updatedAt = data.updated_at ?? createdAt;
  // 派生关系字段统一: DB 列是 parent_id, IPC DTO 同时接受 parent_id / parent_session_id.
  const parentSessionId = data.parent_session_id ?? data.parent_id ?? null;
  // 在 INSERT 前一次性解析 permission_profile. 严禁两阶段写入.
  const permissionProfile: PermissionProfile = resolvePermissionProfile(
    data.permission_profile,
    parentSessionId,
    { isTrustedOverride: data.is_trusted_permission_override === true },
  );
  db().prepare(`
    INSERT INTO chat_sessions (
      id, title, model, system_prompt, working_directory,
      project_name, status, mode, provider_id, generation,
      parent_id, permission_profile, agent_type, agent_name,
      conductor_mode_enabled, conductor_canvas_id,
      created_at, updated_at, is_deleted
    ) VALUES (
      @id, @title, @model, @system_prompt, @working_directory,
      @project_name, @status, @mode, @provider_id, @generation,
      @parent_id, @permission_profile, @agent_type, @agent_name,
      @conductor_mode_enabled, @conductor_canvas_id,
      @created_at, @updated_at, 0
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      model = excluded.model,
      system_prompt = excluded.system_prompt,
      working_directory = excluded.working_directory,
      project_name = excluded.project_name,
      status = excluded.status,
      mode = excluded.mode,
      provider_id = excluded.provider_id,
      parent_id = COALESCE(excluded.parent_id, chat_sessions.parent_id),
      agent_type = COALESCE(excluded.agent_type, chat_sessions.agent_type),
      agent_name = COALESCE(excluded.agent_name, chat_sessions.agent_name),
      updated_at = excluded.updated_at
  `).run({
    id: data.id,
    title: data.title ?? 'New Chat',
    model: data.model ?? '',
    system_prompt: data.system_prompt ?? '',
    working_directory: data.working_directory ?? '',
    project_name: data.project_name ?? '',
    status: data.status ?? 'active',
    mode: data.mode ?? 'code',
    provider_id: data.provider_id ?? 'env',
    generation: data.generation ?? 0,
    parent_id: parentSessionId,
    permission_profile: permissionProfile,
    agent_type: data.agent_type ?? 'main',
    agent_name: data.agent_name ?? '',
    conductor_mode_enabled: data.conductor_mode_enabled ?? 0,
    conductor_canvas_id: data.conductor_canvas_id ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  });
  return db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(data.id) as SessionRow;
}

export function getSession(sessionId: string): SessionRow | undefined {
  return db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
}

const SESSION_FIELD_MAP: Record<string, string> = {
  title: 'title',
  model: 'model',
  system_prompt: 'system_prompt',
  working_directory: 'working_directory',
  project_name: 'project_name',
  status: 'status',
  mode: 'mode',
  permission_profile: 'permission_profile',
  provider_id: 'provider_id',
  context_summary: 'context_summary',
  parent_id: 'parent_id',
  agent_profile_id: 'agent_profile_id',
  agent_type: 'agent_type',
  agent_name: 'agent_name',
  conductor_mode_enabled: 'conductor_mode_enabled',
  conductor_canvas_id: 'conductor_canvas_id',
};

export function updateSession(sessionId: string, data: Record<string, unknown>): SessionRow | undefined {
  const now = Date.now();
  const fields: string[] = ['updated_at = @updated_at'];
  const params: Record<string, unknown> = { sessionId, updated_at: now };

  for (const [key, dbField] of Object.entries(SESSION_FIELD_MAP)) {
    if (data[key] !== undefined) {
      fields.push(`${dbField} = @${key}`);
      params[key] = data[key];
    }
  }

  if (fields.length <= 1) {
    return getSession(sessionId);
  }

  db().prepare(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = @sessionId`).run(params);
  return getSession(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  const txn = db().transaction(() => {
    db().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    const result = db().prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
  });
  return Boolean(txn());
}

export function listSessions(): SessionRow[] {
  return db().prepare(
    "SELECT * FROM chat_sessions WHERE is_deleted = 0 AND mode != 'automation' ORDER BY updated_at DESC"
  ).all() as SessionRow[];
}

export function listSessionsByWorkingDirectory(workingDirectory: string): SessionRow[] {
  if (!workingDirectory || workingDirectory.trim() === '') {
    return db().prepare(
      "SELECT * FROM chat_sessions WHERE is_deleted = 0 AND (working_directory = '' OR working_directory IS NULL) ORDER BY updated_at DESC"
    ).all() as SessionRow[];
  }
  return db().prepare(
    'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = ? ORDER BY updated_at DESC'
  ).all(workingDirectory) as SessionRow[];
}

export function listSessionsByParentId(parentId: string): SessionRow[] {
  return db().prepare(
    'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND parent_id = ? ORDER BY created_at ASC'
  ).all(parentId) as SessionRow[];
}

export function setSessionAgentProfile(sessionId: string, agentProfileId: string): void {
  const now = Date.now();
  db().prepare(
    'UPDATE chat_sessions SET agent_profile_id = ?, updated_at = ? WHERE id = ?'
  ).run(agentProfileId, now, sessionId);
}

// =============================================================================
// Phase 1 CLI control plane: safe DTO query functions
//
// `listSessionSummaries` and `getSessionSummary` are the canonical read-only
// entry points for the CLI control plane. They enforce the user-visible
// session filter (top-level, non-automation, non-gateway, not deleted) and
// return a safe DTO that excludes every internal field. The CLI handler
// layer is a thin HTTP adapter; no field stripping is performed there.
//
// Locked contract (see docs/design-docs/cli-control-plane/phase-1-audit.md
// §12, §15):
//   WHERE: is_deleted = 0
//          AND mode != 'automation'   (mode is NOT NULL DEFAULT 'code')
//          AND id NOT LIKE 'gw-%'
//          AND parent_id IS NULL
//   ORDER: updated_at DESC, id DESC   (deterministic tiebreaker)
//   SELECT: id, title, created_at, updated_at, model, COUNT(messages)
// =============================================================================

/** Bounds for `listSessionSummaries` pagination. */
export const SESSION_LIST_DEFAULT_LIMIT = 20;
export const SESSION_LIST_MIN_LIMIT = 1;
export const SESSION_LIST_MAX_LIMIT = 100;

export interface SessionSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  message_count: number;
}

export interface ListSessionSummariesOptions {
  limit?: number;
  offset?: number;
}

/**
 * Returns top-level user-visible sessions as a safe DTO.
 * Filters: not deleted, not automation, not gateway, parent_id IS NULL.
 * Sorted by updated_at DESC, id DESC (deterministic).
 *
 * IMPORTANT: the SQL is the single source of truth for the filter and
 * field selection. The CLI handler must NOT re-filter on these rows.
 */
export function listSessionSummaries(
  options: ListSessionSummariesOptions = {},
): SessionSummary[] {
  const limit = clampLimit(options.limit ?? SESSION_LIST_DEFAULT_LIMIT);
  const offset = clampOffset(options.offset ?? 0);
  return db()
    .prepare(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         s.updated_at,
         s.model,
         (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count
       FROM chat_sessions s
       WHERE s.is_deleted = 0
         AND s.mode != 'automation'
         AND s.id NOT LIKE 'gw-%'
         AND s.parent_id IS NULL
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as SessionSummary[];
}

/**
 * Returns a single top-level user-visible session as a safe DTO, or
 * `null` if the session is not found / not deleted / is automation /
 * is a gateway session / is a sub-agent. Callers must not distinguish
 * between these cases; the CLI surface maps `null` to 404 session_not_found.
 */
export function getSessionSummary(id: string): SessionSummary | null {
  const row = db()
    .prepare(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         s.updated_at,
         s.model,
         (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count
       FROM chat_sessions s
       WHERE s.id = ?
         AND s.is_deleted = 0
         AND s.mode != 'automation'
         AND s.id NOT LIKE 'gw-%'
         AND s.parent_id IS NULL`,
    )
    .get(id) as SessionSummary | undefined;
  return row ?? null;
}

function clampLimit(raw: number): number {
  if (!Number.isInteger(raw)) {
    throw new InvalidPaginationParam('limit', 'must be an integer');
  }
  if (raw < SESSION_LIST_MIN_LIMIT || raw > SESSION_LIST_MAX_LIMIT) {
    throw new InvalidPaginationParam(
      'limit',
      `must be between ${SESSION_LIST_MIN_LIMIT} and ${SESSION_LIST_MAX_LIMIT}`,
    );
  }
  return raw;
}

function clampOffset(raw: number): number {
  if (!Number.isInteger(raw)) {
    throw new InvalidPaginationParam('offset', 'must be an integer');
  }
  if (raw < 0) {
    throw new InvalidPaginationParam('offset', 'must be a non-negative integer');
  }
  return raw;
}

export class InvalidPaginationParam extends Error {
  constructor(
    public readonly param: 'limit' | 'offset',
    public readonly reason: string,
  ) {
    super(`Invalid ${param}: ${reason}`);
    this.name = 'InvalidPaginationParam';
  }
}
