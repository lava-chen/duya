/**
 * SessionStore — sessions table CRUD + draft + extensions + LIKE search.
 *
 * The `sessions` table is the metadata index for chat sessions. The message
 * payload lives in rollout files (see MessageLog); `rollout_path` is the bridge.
 * Subsystem-specific fields (conductor_canvas_id, system_prompt, etc.) are
 * stored in the `extensions` JSON column, accessed via key-level get/set.
 *
 * Search uses parameterized LIKE (no FTS) — at session-count scale (thousands)
 * LIKE is competitive with FTS5 and handles CJK substrings better (unicode61
 * does not segment Chinese). See design doc decision 2.
 */

import type { Migration, SqliteDatabase } from './database';

// ─── Inline types ───

export interface CoreSession {
  id: string;
  title: string;
  workingDirectory: string;
  projectName: string;
  status: string;
  model: string;
  providerId: string;
  mode: string;
  permissionMode: string;
  agentProfileId: string | null;
  parentSessionId: string | null;
  agentType: string;
  agentName: string;
  draft: string | null;
  extensions: Record<string, unknown>;
  rolloutPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionCreateInput {
  id: string;
  title?: string;
  workingDirectory?: string;
  projectName?: string;
  status?: string;
  model?: string;
  providerId?: string;
  mode?: string;
  permissionMode?: string;
  agentProfileId?: string | null;
  parentSessionId?: string | null;
  agentType?: string;
  agentName?: string;
  draft?: string | null;
  extensions?: Record<string, unknown>;
  rolloutPath?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionPatch {
  title?: string;
  workingDirectory?: string;
  projectName?: string;
  status?: string;
  model?: string;
  providerId?: string;
  mode?: string;
  permissionMode?: string;
  agentProfileId?: string | null;
  parentSessionId?: string | null;
  agentType?: string;
  agentName?: string;
  draft?: string | null;
  rolloutPath?: string | null;
}

export interface SessionListFilter {
  workingDirectory?: string;
  parentSessionId?: string;
  status?: string;
  /** Modes to exclude (e.g. ['automation'] to filter out cron sessions). */
  excludeModes?: string[];
  /**
   * When true, include soft-deleted sessions (status='deleted') in the
   * result. Defaults to false — deleted sessions are filtered out.
   * Used by memory-state catalogSync to preserve tombstone semantics.
   */
  includeDeleted?: boolean;
}

// ─── SessionStore ───

export class SessionStore {
  /** Migration id=2: create sessions table (no FTS). */
  static readonly migrations: Migration[] = [
    {
      id: 2,
      name: 'create_sessions',
      up: (db) => {
        db.exec(`
          CREATE TABLE sessions (
            id                TEXT PRIMARY KEY,
            title             TEXT NOT NULL DEFAULT 'New Chat',
            working_directory TEXT NOT NULL DEFAULT '',
            project_name      TEXT NOT NULL DEFAULT '',
            status            TEXT NOT NULL DEFAULT 'active',
            model             TEXT NOT NULL DEFAULT '',
            provider_id       TEXT NOT NULL DEFAULT 'env',
            mode              TEXT NOT NULL DEFAULT 'code',
            permission_mode   TEXT NOT NULL DEFAULT 'default',
            agent_profile_id  TEXT,
            parent_session_id TEXT,
            agent_type        TEXT NOT NULL DEFAULT 'main',
            agent_name        TEXT NOT NULL DEFAULT '',
            draft             TEXT,
            extensions        TEXT NOT NULL DEFAULT '{}',
            rollout_path      TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
          );
          CREATE INDEX idx_sessions_working_dir ON sessions(working_directory, updated_at);
          CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
          CREATE INDEX idx_sessions_updated ON sessions(updated_at);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ─── CRUD ───

  create(input: SessionCreateInput): CoreSession {
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, working_directory, project_name, status, model, provider_id,
          mode, permission_mode, agent_profile_id, parent_session_id, agent_type,
          agent_name, draft, extensions, rollout_path, created_at, updated_at
        ) VALUES (
          @id, @title, @working_directory, @project_name, @status, @model, @provider_id,
          @mode, @permission_mode, @agent_profile_id, @parent_session_id, @agent_type,
          @agent_name, @draft, @extensions, @rollout_path, @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id,
        title: input.title ?? 'New Chat',
        working_directory: input.workingDirectory ?? '',
        project_name: input.projectName ?? '',
        status: input.status ?? 'active',
        model: input.model ?? '',
        provider_id: input.providerId ?? 'env',
        mode: input.mode ?? 'code',
        permission_mode: input.permissionMode ?? 'default',
        agent_profile_id: input.agentProfileId ?? null,
        parent_session_id: input.parentSessionId ?? null,
        agent_type: input.agentType ?? 'main',
        agent_name: input.agentName ?? '',
        draft: input.draft ?? null,
        extensions: JSON.stringify(input.extensions ?? {}),
        rollout_path: input.rolloutPath ?? null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    return this.get(input.id)!;
  }

  get(id: string): CoreSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? rowToSession(row as SessionRow) : null;
  }

  update(id: string, patch: SessionPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.title !== undefined) { sets.push('title = @title'); params.title = patch.title; }
    if (patch.workingDirectory !== undefined) { sets.push('working_directory = @working_directory'); params.working_directory = patch.workingDirectory; }
    if (patch.projectName !== undefined) { sets.push('project_name = @project_name'); params.project_name = patch.projectName; }
    if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
    if (patch.model !== undefined) { sets.push('model = @model'); params.model = patch.model; }
    if (patch.providerId !== undefined) { sets.push('provider_id = @provider_id'); params.provider_id = patch.providerId; }
    if (patch.mode !== undefined) { sets.push('mode = @mode'); params.mode = patch.mode; }
    if (patch.permissionMode !== undefined) { sets.push('permission_mode = @permission_mode'); params.permission_mode = patch.permissionMode; }
    if (patch.agentProfileId !== undefined) { sets.push('agent_profile_id = @agent_profile_id'); params.agent_profile_id = patch.agentProfileId; }
    if (patch.parentSessionId !== undefined) { sets.push('parent_session_id = @parent_session_id'); params.parent_session_id = patch.parentSessionId; }
    if (patch.agentType !== undefined) { sets.push('agent_type = @agent_type'); params.agent_type = patch.agentType; }
    if (patch.agentName !== undefined) { sets.push('agent_name = @agent_name'); params.agent_name = patch.agentName; }
    if (patch.draft !== undefined) { sets.push('draft = @draft'); params.draft = patch.draft; }
    if (patch.rolloutPath !== undefined) { sets.push('rollout_path = @rollout_path'); params.rollout_path = patch.rolloutPath; }
    if (sets.length === 0) return;
    sets.push('updated_at = @updated_at');
    params.updated_at = Date.now();
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  list(filter: SessionListFilter = {}): CoreSession[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.workingDirectory !== undefined) {
      conditions.push('working_directory = @working_directory');
      params.working_directory = filter.workingDirectory;
    }
    if (filter.parentSessionId !== undefined) {
      conditions.push('parent_session_id = @parent_session_id');
      params.parent_session_id = filter.parentSessionId;
    }
    if (filter.status !== undefined) {
      conditions.push('status = @status');
      params.status = filter.status;
    } else if (!filter.includeDeleted) {
      conditions.push("status != 'deleted'");
    }
    if (filter.excludeModes && filter.excludeModes.length > 0) {
      const placeholders = filter.excludeModes.map((_, i) => `@em${i}`).join(',');
      conditions.push(`mode NOT IN (${placeholders})`);
      filter.excludeModes.forEach((m, i) => { params[`em${i}`] = m; });
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC`)
      .all(params) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Hard delete. Test/rollback only — runtime deletion uses `status='deleted'`. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ─── Draft ───

  saveDraft(id: string, draft: string): void {
    this.db
      .prepare('UPDATE sessions SET draft = ?, updated_at = ? WHERE id = ?')
      .run(draft, Date.now(), id);
  }

  getDraft(id: string): string {
    const row = this.db
      .prepare('SELECT draft FROM sessions WHERE id = ?')
      .get(id) as { draft: string | null } | undefined;
    return row?.draft ?? '';
  }

  // ─── Extensions (key-level JSON access) ───

  getExtension(id: string, key: string): unknown {
    const row = this.db
      .prepare('SELECT extensions FROM sessions WHERE id = ?')
      .get(id) as { extensions: string } | undefined;
    if (!row) return undefined;
    try {
      const ext = JSON.parse(row.extensions) as Record<string, unknown>;
      return ext[key];
    } catch {
      return undefined;
    }
  }

  setExtension(id: string, key: string, value: unknown): void {
    const row = this.db
      .prepare('SELECT extensions FROM sessions WHERE id = ?')
      .get(id) as { extensions: string } | undefined;
    const ext: Record<string, unknown> = row ? safeParse(row.extensions) : {};
    ext[key] = value;
    this.db
      .prepare('UPDATE sessions SET extensions = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(ext), Date.now(), id);
  }

  // ─── Rollout path ───

  getRolloutPath(id: string): string | null {
    const row = this.db
      .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
      .get(id) as { rollout_path: string | null } | undefined;
    return row?.rollout_path ?? null;
  }

  setRolloutPath(id: string, rolloutPath: string): void {
    this.db
      .prepare('UPDATE sessions SET rollout_path = ?, updated_at = ? WHERE id = ?')
      .run(rolloutPath, Date.now(), id);
  }

  // ─── Search ───

  /**
   * LIKE search over title / project_name / agent_name. Escapes `%` `_` `\`,
   * excludes soft-deleted sessions, sorts by updated_at DESC.
   */
  search(query: string, limit = 50): CoreSession[] {
    const escaped = escapeLike(query);
    const pattern = `%${escaped}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status != 'deleted'
           AND (title LIKE @pattern ESCAPE '\\'
                OR project_name LIKE @pattern ESCAPE '\\'
                OR agent_name LIKE @pattern ESCAPE '\\')
         ORDER BY updated_at DESC
         LIMIT @limit`,
      )
      .all({ pattern, limit }) as SessionRow[];
    return rows.map(rowToSession);
  }

  // ─── Summaries (CLI control plane) ───

  /**
   * List top-level user-visible sessions with a `message_count` aggregate
   * from `message_index`. Mirrors the legacy `listSessionSummaries` SQL
   * (Plan 99 P3) but reads from the core `sessions` + `message_index`
   * tables. Filters: not deleted, not automation, not gateway, no parent.
   * Sorted by updated_at DESC, id DESC (deterministic).
   */
  listSummaries(opts: SessionSummaryOptions = {}): SessionSummary[] {
    const limit = clampLimit(opts.limit ?? SESSION_LIST_DEFAULT_LIMIT);
    const offset = clampOffset(opts.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT
           s.id,
           s.title,
           s.created_at,
           s.updated_at,
           s.model,
           (SELECT COUNT(*) FROM message_index WHERE session_id = s.id) AS message_count
         FROM sessions s
         WHERE s.status != 'deleted'
           AND s.mode != 'automation'
           AND s.id NOT LIKE 'gw-%'
           AND s.parent_session_id IS NULL
         ORDER BY s.updated_at DESC, s.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as SessionSummary[];
    return rows;
  }

  /**
   * Return a single session summary, or null if the session is not
   * visible (deleted / automation / gateway / sub-agent / missing).
   */
  getSummary(id: string): SessionSummary | null {
    const row = this.db
      .prepare(
        `SELECT
           s.id,
           s.title,
           s.created_at,
           s.updated_at,
           s.model,
           (SELECT COUNT(*) FROM message_index WHERE session_id = s.id) AS message_count
         FROM sessions s
         WHERE s.id = ?
           AND s.status != 'deleted'
           AND s.mode != 'automation'
           AND s.id NOT LIKE 'gw-%'
           AND s.parent_session_id IS NULL`,
      )
      .get(id) as SessionSummary | undefined;
    return row ?? null;
  }
}

// ─── Session summary DTO + pagination (CLI control plane) ───

/**
 * Safe DTO returned to the CLI control plane. Mirrors the legacy
 * `SessionSummary` shape so renderer / CLI consumers stay unchanged.
 */
export interface SessionSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  message_count: number;
}

export interface SessionSummaryOptions {
  limit?: number;
  offset?: number;
}

/** Bounds for `listSummaries` pagination. */
export const SESSION_LIST_DEFAULT_LIMIT = 20;
export const SESSION_LIST_MIN_LIMIT = 1;
export const SESSION_LIST_MAX_LIMIT = 100;

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

/**
 * Error thrown when a CLI pagination parameter (limit / offset) is
 * malformed. The CLI handler maps it to a 400 response with
 * `invalid_<param>` code.
 */
export class InvalidPaginationParam extends Error {
  constructor(
    public readonly param: 'limit' | 'offset',
    public readonly reason: string,
  ) {
    super(`Invalid ${param}: ${reason}`);
    this.name = 'InvalidPaginationParam';
  }
}

// ─── Helpers ───

interface SessionRow {
  id: string;
  title: string;
  working_directory: string;
  project_name: string;
  status: string;
  model: string;
  provider_id: string;
  mode: string;
  permission_mode: string;
  agent_profile_id: string | null;
  parent_session_id: string | null;
  agent_type: string;
  agent_name: string;
  draft: string | null;
  extensions: string;
  rollout_path: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: SessionRow): CoreSession {
  return {
    id: row.id,
    title: row.title,
    workingDirectory: row.working_directory,
    projectName: row.project_name,
    status: row.status,
    model: row.model,
    providerId: row.provider_id,
    mode: row.mode,
    permissionMode: row.permission_mode,
    agentProfileId: row.agent_profile_id,
    parentSessionId: row.parent_session_id,
    agentType: row.agent_type,
    agentName: row.agent_name,
    draft: row.draft,
    extensions: safeParse(row.extensions),
    rolloutPath: row.rollout_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Escape LIKE special characters so they match literally. */
function escapeLike(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
