/**
 * stores.ts — three small aggregates in one file:
 *   - TaskStore          (tasks: CRUD + claim + block + unassign)
 *   - PermissionLedger   (permission_requests: create + resolve + list)
 *   - LockStore          (session_runtime_locks: acquire + renew + release + isLocked)
 *
 * Plan 327 decision 8: these three classes are each under 100 lines of single-table
 * CRUD. Splitting them into 6 files would buy no boundary value, so they share
 * one module and one test file (`stores.test.ts`). Aggregate boundaries are
 * expressed by the class, not the directory. Types are inline-exported.
 *
 * DDL is near-ported from the legacy tables in `electron/db/schema.ts` (only
 * index names and CHECK defaults cleaned up). Method surface is a 1:1 cover of
 * the consumer contracts:
 *  - `taskDb`     (`packages/agent/src/ipc/db-client.ts:223-250`)
 *  - `permissionDb` (same file, lines 296-315)
 *  - `lockDb`      (same file, lines 208-218)
 * plus the renderer-side IPC handlers in `electron/ipc/db-handlers.ts`.
 *
 * See `docs/design-docs/2026-08-06-core-database-architecture.md` for the
 * aggregate-grouping rationale.
 */

import type { Migration, SqliteDatabase } from './database';

// ─── TaskStore ───

export interface CoreTask {
  id: string;
  sessionId: string;
  subject: string;
  description: string;
  status: string;
  activeForm: string | null;
  owner: string | null;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskCreateInput {
  id: string;
  sessionId: string;
  subject: string;
  description: string;
  activeForm?: string | null;
  owner?: string | null;
}

export interface TaskUpdateInput {
  subject?: string;
  description?: string;
  status?: string;
  activeForm?: string | null;
  owner?: string | null;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskClaimResult {
  success: boolean;
  reason?: 'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked';
  task?: CoreTask;
  blockedByTasks?: string[];
}

export interface UnassignTeammateResult {
  unassignedTasks: Array<{ id: string; subject: string }>;
  notificationMessage: string;
}

export class TaskStore {
  /** Migration id=5: create tasks table. */
  static readonly migrations: Migration[] = [
    {
      id: 5,
      name: 'create_tasks',
      up: (db) => {
        db.exec(`
          CREATE TABLE tasks (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            subject     TEXT NOT NULL,
            description TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            active_form TEXT,
            owner       TEXT,
            blocks      TEXT NOT NULL DEFAULT '[]',
            blocked_by  TEXT NOT NULL DEFAULT '[]',
            metadata    TEXT NOT NULL DEFAULT '{}',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
          );
          CREATE INDEX idx_tasks_session ON tasks(session_id, created_at);
          CREATE INDEX idx_tasks_owner ON tasks(session_id, owner);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) { this.db = db; }

  create(input: TaskCreateInput): CoreTask {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, session_id, subject, description, active_form, owner,
          status, blocks, blocked_by, metadata, created_at, updated_at
        ) VALUES (
          @id, @session_id, @subject, @description, @active_form, @owner,
          'pending', '[]', '[]', '{}', @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id,
        session_id: input.sessionId,
        subject: input.subject,
        description: input.description,
        active_form: input.activeForm ?? null,
        owner: input.owner ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(input.id)!;
  }

  get(id: string): CoreTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getBySession(sessionId: string): CoreTask[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as TaskRow[];
    return rows.map(rowToTask);
  }

  update(id: string, input: TaskUpdateInput): CoreTask | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.subject !== undefined) { sets.push('subject = @subject'); params.subject = input.subject; }
    if (input.description !== undefined) { sets.push('description = @description'); params.description = input.description; }
    if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
    if (input.activeForm !== undefined) { sets.push('active_form = @active_form'); params.active_form = input.activeForm; }
    if (input.owner !== undefined) { sets.push('owner = @owner'); params.owner = input.owner; }
    if (input.blocks !== undefined) { sets.push('blocks = @blocks'); params.blocks = JSON.stringify(input.blocks); }
    if (input.blockedBy !== undefined) { sets.push('blocked_by = @blocked_by'); params.blocked_by = JSON.stringify(input.blockedBy); }
    if (input.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = JSON.stringify(input.metadata); }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = @updated_at');
    params.updated_at = Date.now();
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  /** Hard delete one task. Returns true if a row was removed. */
  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return r.changes > 0;
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId);
  }

  /**
   * Claim a task for an owner. Idempotent: re-claiming by the same owner is a
   * no-op success. Rejects if already claimed by another owner, already
   * resolved (status='completed'), or blocked by unresolved tasks.
   */
  claim(id: string, owner: string): TaskClaimResult {
    const now = Date.now();
    const txn = this.db.transaction((): TaskClaimResult => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
      if (!row) return { success: false, reason: 'task_not_found' };
      if (row.owner && row.owner !== owner) return { success: false, reason: 'already_claimed' };
      if (row.status === 'completed') return { success: false, reason: 'already_resolved' };

      const blockedBy = safeParseStringArray(row.blocked_by);
      if (blockedBy.length > 0) {
        const placeholders = blockedBy.map(() => '?').join(',');
        const unresolved = this.db
          .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status != 'completed'`)
          .all(...blockedBy) as { id: string }[];
        if (unresolved.length > 0) {
          return { success: false, reason: 'blocked', blockedByTasks: unresolved.map((r) => r.id) };
        }
      }

      this.db
        .prepare("UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = ? WHERE id = ?")
        .run(owner, now, id);
      return { success: true, task: this.get(id) };
    });
    return txn();
  }

  /**
   * Maintain bidirectional block edges: fromId.blocks += toId, toId.blockedBy += fromId.
   * Idempotent — does not duplicate existing entries. Returns false if either
   * task is missing.
   */
  block(fromId: string, toId: string): boolean {
    const from = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(fromId) as TaskRow | undefined;
    const to = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(toId) as TaskRow | undefined;
    if (!from || !to) return false;
    const now = Date.now();

    const fromBlocks = safeParseStringArray(from.blocks);
    if (!fromBlocks.includes(toId)) {
      fromBlocks.push(toId);
      this.db.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fromBlocks), now, fromId);
    }
    const toBlockedBy = safeParseStringArray(to.blocked_by);
    if (!toBlockedBy.includes(fromId)) {
      toBlockedBy.push(fromId);
      this.db.prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(toBlockedBy), now, toId);
    }
    return true;
  }

  /**
   * Release all non-completed tasks owned by `owner` in `sessionId` (set owner=NULL,
   * status='pending'). Returns the released tasks + a notification message.
   */
  unassignTeammate(sessionId: string, owner: string): UnassignTeammateResult {
    const now = Date.now();
    const tasks = this.db
      .prepare("SELECT id, subject FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?")
      .all(sessionId, owner) as { id: string; subject: string }[];
    if (tasks.length === 0) return { unassignedTasks: [], notificationMessage: '' };

    this.db
      .prepare("UPDATE tasks SET owner = NULL, status = 'pending', updated_at = ? WHERE session_id = ? AND status != 'completed' AND owner = ?")
      .run(now, sessionId, owner);

    const taskList = tasks.map((t) => `#${t.id} "${t.subject}"`).join(', ');
    return {
      unassignedTasks: tasks.map((t) => ({ id: t.id, subject: t.subject })),
      notificationMessage: `${owner} was terminated. ${tasks.length} task(s) were unassigned: ${taskList}.`,
    };
  }

  getByOwner(sessionId: string, owner: string): CoreTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?")
      .all(sessionId, owner) as TaskRow[];
    return rows.map(rowToTask);
  }
}

// ─── PermissionLedger ───

export type PermissionStatus = 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted';

export interface PermissionRequest {
  id: string;
  sessionId: string | null;
  toolName: string;
  toolInput: Record<string, unknown> | null;
  status: PermissionStatus;
  decision: string | null;
  message: string | null;
  updatedPermissions: unknown[] | null;
  updatedInput: Record<string, unknown> | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PermissionCreateInput {
  id: string;
  sessionId?: string | null;
  toolName: string;
  toolInput?: Record<string, unknown> | null;
}

export interface PermissionResolveInput {
  status: PermissionStatus;
  decision?: string;
  message?: string;
  updatedPermissions?: unknown[];
  updatedInput?: Record<string, unknown>;
}

export class PermissionLedger {
  /** Migration id=6: create permission_requests table. */
  static readonly migrations: Migration[] = [
    {
      id: 6,
      name: 'create_permission_requests',
      up: (db) => {
        db.exec(`
          CREATE TABLE permission_requests (
            id                  TEXT PRIMARY KEY,
            session_id          TEXT,
            tool_name           TEXT NOT NULL,
            tool_input          TEXT,
            status              TEXT NOT NULL DEFAULT 'pending',
            decision            TEXT,
            message             TEXT,
            updated_permissions TEXT,
            updated_input       TEXT,
            created_at          INTEGER NOT NULL,
            resolved_at         INTEGER
          );
          CREATE INDEX idx_permission_session ON permission_requests(session_id);
          CREATE INDEX idx_permission_status ON permission_requests(status);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) { this.db = db; }

  create(input: PermissionCreateInput): PermissionRequest {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO permission_requests (
          id, session_id, tool_name, tool_input, status, created_at
        ) VALUES (
          @id, @session_id, @tool_name, @tool_input, 'pending', @created_at
        )`,
      )
      .run({
        id: input.id,
        session_id: input.sessionId ?? null,
        tool_name: input.toolName,
        tool_input: input.toolInput ? JSON.stringify(input.toolInput) : null,
        created_at: now,
      });
    return this.get(input.id)!;
  }

  get(id: string): PermissionRequest | null {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as PermissionRow | undefined;
    return row ? rowToPermission(row) : null;
  }

  /**
   * Resolve a pending request. Idempotent: a request already in a terminal
   * status (allow/deny/timeout/aborted) is returned unchanged — `resolved_at`
   * is not overwritten. Writes `decision` (defaults to `status`), `message`,
   * `updatedPermissions`, `updatedInput`, and stamps `resolved_at` if pending.
   */
  resolve(id: string, input: PermissionResolveInput): PermissionRequest | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE permission_requests SET
          status = @status,
          decision = @decision,
          message = @message,
          updated_permissions = @updated_permissions,
          updated_input = @updated_input,
          resolved_at = @resolved_at
        WHERE id = @id`,
      )
      .run({
        id,
        status: input.status,
        decision: input.decision ?? input.status,
        message: input.message ?? null,
        updated_permissions: input.updatedPermissions ? JSON.stringify(input.updatedPermissions) : null,
        updated_input: input.updatedInput ? JSON.stringify(input.updatedInput) : null,
        resolved_at: now,
      });
    return this.get(id);
  }

  listPending(sessionId?: string): PermissionRequest[] {
    if (sessionId !== undefined) {
      const rows = this.db
        .prepare("SELECT * FROM permission_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC")
        .all(sessionId) as PermissionRow[];
      return rows.map(rowToPermission);
    }
    const rows = this.db
      .prepare("SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as PermissionRow[];
    return rows.map(rowToPermission);
  }

  listBySession(sessionId: string): PermissionRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM permission_requests WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as PermissionRow[];
    return rows.map(rowToPermission);
  }
}

// ─── LockStore ───

export class LockStore {
  /** Migration id=7: create session_runtime_locks (near-verbatim port). */
  static readonly migrations: Migration[] = [
    {
      id: 7,
      name: 'create_session_runtime_locks',
      up: (db) => {
        db.exec(`
          CREATE TABLE session_runtime_locks (
            session_id TEXT PRIMARY KEY,
            lock_id    TEXT NOT NULL,
            owner      TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          );
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) { this.db = db; }

  /**
   * Acquire a lock for `sessionId` with `lockId`/`owner`. Returns true on
   * success. If an existing (un-expired) lock with a different `lockId` is
   * held, returns false. Expired locks are reaped first, then the new row is
   * inserted (collision → false via the PRIMARY KEY constraint).
   */
  acquire(sessionId: string, lockId: string, owner: string, ttlSec = 300): boolean {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;
    const txn = this.db.transaction((): boolean => {
      this.db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
      // Check existing lock with a different lockId
      const existing = this.db
        .prepare('SELECT lock_id, expires_at FROM session_runtime_locks WHERE session_id = ?')
        .get(sessionId) as { lock_id: string; expires_at: number } | undefined;
      if (existing && existing.lock_id !== lockId && existing.expires_at > now) {
        return false;
      }
      try {
        this.db
          .prepare(
            'INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at) VALUES (?, ?, ?, ?)',
          )
          .run(sessionId, lockId, owner, expiresAt);
        return true;
      } catch {
        // PRIMARY KEY collision — row already exists, replace via UPSERT
        this.db
          .prepare(
            'UPDATE session_runtime_locks SET lock_id = ?, owner = ?, expires_at = ? WHERE session_id = ?',
          )
          .run(lockId, owner, expiresAt, sessionId);
        return true;
      }
    });
    return txn();
  }

  /**
   * Extend the lease. Only succeeds if `lockId` matches the holder. Returns
   * true on success, false if the lock is missing or held under another lockId.
   */
  renew(sessionId: string, lockId: string, ttlSec = 300): boolean {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;
    const result = this.db
      .prepare('UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ? AND lock_id = ?')
      .run(expiresAt, sessionId, lockId);
    return result.changes > 0;
  }

  /**
   * Release the lock. Only succeeds if `lockId` matches the holder. Returns
   * true if a row was deleted.
   */
  release(sessionId: string, lockId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?')
      .run(sessionId, lockId);
    return result.changes > 0;
  }

  /**
   * True if `sessionId` is currently locked (a non-expired lock exists).
   * Reaps expired rows as a side effect.
   */
  isLocked(sessionId: string): boolean {
    const now = Date.now();
    this.db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
    const row = this.db
      .prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?')
      .get(sessionId);
    return row !== undefined;
  }
}

// ─── Helpers ───

interface TaskRow {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  status: string;
  active_form: string | null;
  owner: string | null;
  blocks: string;
  blocked_by: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

interface PermissionRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  tool_input: string | null;
  status: PermissionStatus;
  decision: string | null;
  message: string | null;
  updated_permissions: string | null;
  updated_input: string | null;
  created_at: number;
  resolved_at: number | null;
}

function rowToTask(row: TaskRow): CoreTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    activeForm: row.active_form,
    owner: row.owner,
    blocks: safeParseStringArray(row.blocks),
    blockedBy: safeParseStringArray(row.blocked_by),
    metadata: safeParseObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPermission(row: PermissionRow): PermissionRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input ? safeParseObject(row.tool_input) : null,
    status: row.status,
    decision: row.decision,
    message: row.message,
    updatedPermissions: row.updated_permissions ? safeParseArray(row.updated_permissions) : null,
    updatedInput: row.updated_input ? safeParseObject(row.updated_input) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function safeParseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function safeParseObject(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeParseArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
