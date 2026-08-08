/**
 * stores.ts — six small aggregates in one file:
 *   - TaskStore          (tasks: CRUD + claim + block + unassign)
 *   - PermissionLedger   (permission_requests: create + resolve + list)
 *   - LockStore          (session_runtime_locks: acquire + renew + release + isLocked)
 *   - GoalStore          (session_goals: per-session goal + token budget mirror)
 *   - SpawnEdgeStore     (session_spawn_edges: sub-agent lineage, plan 332)
 *   - AttachmentStore    (attachments: file-backed payloads, plan 332)
 *
 * Plan 327 decision 8: TaskStore / PermissionLedger / LockStore are each under
 * 100 lines of single-table CRUD. Splitting them into 6 files would buy no
 * boundary value, so they share one module and one test file
 * (`stores.test.ts`). Plan 331 extends the same grouping to GoalStore:
 * single-table CRUD, under 150 lines, no cross-aggregate invariants. Plan 332
 * adds SpawnEdgeStore (lineage) and AttachmentStore (file-backed payloads).
 *
 * DDL is near-ported from the legacy tables in `electron/db/schema.ts` (only
 * index names and CHECK defaults cleaned up). Method surface is a 1:1 cover of
 * the consumer contracts:
 *  - `taskDb`     (`packages/agent/src/ipc/db-client.ts:223-250`)
 *  - `permissionDb` (same file, lines 296-315)
 *  - `lockDb`      (same file, lines 208-218)
 *  - `goalDb`      (Plan 331 Phase 2 — see db-client.ts)
 * plus the renderer-side IPC handlers in `electron/ipc/db-handlers.ts`.
 *
 * See `docs/design-docs/2026-08-06-core-database-architecture.md` for the
 * aggregate-grouping rationale.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

// ─── GoalStore ───

/**
 * Goal status state machine (Plan 331 decision 2). Simplified from Codex's
 * 6-state model to 4 states — duya has no external blocking source, so
 * `blocked` and `budget_limited` collapse into `usage_limited`.
 */
export type GoalStatus = 'active' | 'paused' | 'usage_limited' | 'complete';

export interface SessionGoal {
  id: string;
  sessionId: string;
  goalText: string | null;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GoalCreateInput {
  id: string;
  sessionId: string;
  goalText?: string | null;
  tokenBudget?: number | null;
}

export interface GoalBudgetDelta {
  tokensUsedDelta?: number;
  timeUsedDelta?: number;
}

export class GoalStore {
  /** Migration id=8: create session_goals table (Plan 331 Phase 1). */
  static readonly migrations: Migration[] = [
    {
      id: 8,
      name: 'create_session_goals',
      up: (db) => {
        db.exec(`
          CREATE TABLE session_goals (
            id               TEXT PRIMARY KEY,
            session_id       TEXT NOT NULL,
            goal_text        TEXT,
            status           TEXT NOT NULL DEFAULT 'active'
                             CHECK(status IN('active','paused','usage_limited','complete')),
            token_budget     INTEGER,
            tokens_used      INTEGER NOT NULL DEFAULT 0,
            time_used_seconds INTEGER NOT NULL DEFAULT 0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL,
            completed_at     INTEGER,
            UNIQUE(session_id)
          );
          CREATE INDEX idx_goals_session ON session_goals(session_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) { this.db = db; }

  /**
   * Insert a new goal. Defaults: status='active', tokens_used=0,
   * time_used_seconds=0. The UNIQUE(session_id) constraint means each
   * session can have at most one goal — callers should upsert via
   * `get` + `create` if they need idempotent semantics.
   */
  create(input: GoalCreateInput): SessionGoal {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_goals (
          id, session_id, goal_text, token_budget, status,
          tokens_used, time_used_seconds, created_at, updated_at
        ) VALUES (
          @id, @session_id, @goal_text, @token_budget, 'active',
          0, 0, @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id,
        session_id: input.sessionId,
        goal_text: input.goalText ?? null,
        token_budget: input.tokenBudget ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(input.sessionId)!;
  }

  /** Get the goal for a session (null if no row or session missing). */
  get(sessionId: string): SessionGoal | null {
    const row = this.db
      .prepare('SELECT * FROM session_goals WHERE session_id = ?')
      .get(sessionId) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /**
   * Apply a delta to the token/time accumulators. Uses `MAX(0, ...)` to
   * guard against negative underflow (a stale delta from a crashed turn
   * should never drive the counter below zero). Returns the updated row or
   * null if the session has no goal.
   */
  updateBudget(sessionId: string, delta: GoalBudgetDelta): SessionGoal | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { session_id: sessionId };
    if (delta.tokensUsedDelta !== undefined && delta.tokensUsedDelta !== 0) {
      sets.push('tokens_used = MAX(0, tokens_used + @tokens_delta)');
      params.tokens_delta = delta.tokensUsedDelta;
    }
    if (delta.timeUsedDelta !== undefined && delta.timeUsedDelta !== 0) {
      sets.push('time_used_seconds = MAX(0, time_used_seconds + @time_delta)');
      params.time_delta = delta.timeUsedDelta;
    }
    if (sets.length === 0) return this.get(sessionId);
    sets.push('updated_at = @updated_at');
    params.updated_at = Date.now();
    this.db
      .prepare(`UPDATE session_goals SET ${sets.join(', ')} WHERE session_id = @session_id`)
      .run(params);
    return this.get(sessionId);
  }

  /**
   * Transition the goal to a new status. Stamps `completed_at` when
   * transitioning to 'complete' (idempotent — already-complete goals keep
   * their original `completed_at`). Returns the updated row or null.
   */
  setStatus(sessionId: string, status: GoalStatus): SessionGoal | null {
    const now = Date.now();
    const sets: string[] = ['status = @status', 'updated_at = @updated_at'];
    const params: Record<string, unknown> = { session_id: sessionId, status, updated_at: now };
    if (status === 'complete') {
      // Only stamp completed_at if it's currently null (idempotent).
      sets.push("completed_at = COALESCE(completed_at, @completed_at)");
      params.completed_at = now;
    }
    this.db
      .prepare(`UPDATE session_goals SET ${sets.join(', ')} WHERE session_id = @session_id`)
      .run(params);
    return this.get(sessionId);
  }

  /** List all goals in a given status (e.g. all `usage_limited` sessions). */
  listByStatus(status: GoalStatus): SessionGoal[] {
    const rows = this.db
      .prepare('SELECT * FROM session_goals WHERE status = ? ORDER BY updated_at DESC')
      .all(status) as GoalRow[];
    return rows.map(rowToGoal);
  }

  /** Delete the goal for a session. Returns true if a row was removed. */
  delete(sessionId: string): boolean {
    const r = this.db.prepare('DELETE FROM session_goals WHERE session_id = ?').run(sessionId);
    return r.changes > 0;
  }
}

// ─── SpawnEdgeStore ───

export interface SpawnEdge {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  spawnTurnId: string | null;
  spawnReason: string | null;
  spawnType: string;
  spawnedAt: number;
}

export interface SpawnEdgeRecordInput {
  parentSessionId: string;
  childSessionId: string;
  spawnTurnId?: string | null;
  spawnReason?: string | null;
  spawnType?: string;
}

/**
 * Record the parent→child lineage of sub-agent sessions (plan 332 Phase 1).
 *
 * The `sessions.parent_session_id` column only captures the direct parent.
 * This edge table is the complete lineage truth source: it records *which*
 * turn spawned the child, *why*, and *what kind* of spawn it was. The CTE-based
 * `getTree` walks the full spawn tree so a UI/tool can render a lineage view.
 *
 * The edge id is `parentSessionId->childSessionId`, so recording the same
 * child twice is an idempotent no-op (INSERT OR IGNORE).
 */
export class SpawnEdgeStore {
  /** Migration id=9: create session_spawn_edges. */
  static readonly migrations: Migration[] = [
    {
      id: 9,
      name: 'create_session_spawn_edges',
      up: (db) => {
        db.exec(`
          CREATE TABLE session_spawn_edges (
            id                TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL,
            child_session_id  TEXT NOT NULL,
            spawn_turn_id     TEXT,
            spawn_reason      TEXT,
            spawn_type        TEXT NOT NULL DEFAULT 'subagent',
            spawned_at        INTEGER NOT NULL
          );
          CREATE INDEX idx_spawn_parent ON session_spawn_edges(parent_session_id);
          CREATE INDEX idx_spawn_child ON session_spawn_edges(child_session_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) { this.db = db; }

  /** Record a spawn edge. Idempotent — re-recording the same child is a no-op. */
  record(input: SpawnEdgeRecordInput): SpawnEdge {
    const id = `${input.parentSessionId}->${input.childSessionId}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_spawn_edges (
          id, parent_session_id, child_session_id, spawn_turn_id, spawn_reason,
          spawn_type, spawned_at
        ) VALUES (
          @id, @parent_session_id, @child_session_id, @spawn_turn_id, @spawn_reason,
          @spawn_type, @spawned_at
        )`,
      )
      .run({
        id,
        parent_session_id: input.parentSessionId,
        child_session_id: input.childSessionId,
        spawn_turn_id: input.spawnTurnId ?? null,
        spawn_reason: input.spawnReason ?? null,
        spawn_type: input.spawnType ?? 'subagent',
        spawned_at: Date.now(),
      });
    return this.get(id)!;
  }

  get(id: string): SpawnEdge | null {
    const row = this.db.prepare('SELECT * FROM session_spawn_edges WHERE id = ?').get(id) as SpawnEdgeRow | undefined;
    return row ? rowToSpawnEdge(row) : null;
  }

  /** All direct children of a parent, oldest spawn first. */
  listChildren(parentSessionId: string): SpawnEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM session_spawn_edges WHERE parent_session_id = ? ORDER BY spawned_at ASC')
      .all(parentSessionId) as SpawnEdgeRow[];
    return rows.map(rowToSpawnEdge);
  }

  /** The edge that spawned a child, or null if `childSessionId` is a root. */
  getParent(childSessionId: string): SpawnEdge | null {
    const row = this.db
      .prepare('SELECT * FROM session_spawn_edges WHERE child_session_id = ?')
      .get(childSessionId) as SpawnEdgeRow | undefined;
    return row ? rowToSpawnEdge(row) : null;
  }

  /**
   * Walk the full descendant spawn tree rooted at `sessionId` via a recursive
   * CTE. Returns every edge reachable from `sessionId` (children, grandchildren,
   * ...). Helper edges are deduped by the UNION semantics of the CTE.
   */
  getTree(sessionId: string): SpawnEdge[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree AS (
           SELECT * FROM session_spawn_edges WHERE parent_session_id = ?
           UNION ALL
           SELECT e.* FROM session_spawn_edges e
             JOIN tree t ON e.parent_session_id = t.child_session_id
         )
         SELECT * FROM tree`,
      )
      .all(sessionId) as SpawnEdgeRow[];
    return rows.map(rowToSpawnEdge);
  }
}

// ─── AttachmentStore ───

export interface CoreAttachment {
  id: string;
  messageId: string | null;
  sessionId: string;
  attachmentType: string;
  mimeType: string | null;
  filePath: string;
  originalUrl: string | null;
  createdAt: number;
}

/** An attachment index row plus its payload read back from the file. */
export interface AttachmentWithData extends CoreAttachment {
  data: string;
}

export interface AttachmentSaveInput {
  /** Stable id — when omitted a UUID is generated. Used for idempotent imports. */
  id?: string;
  messageId?: string | null;
  sessionId: string;
  /** Attachment kind, e.g. 'parsed_document'. */
  type: string;
  mimeType?: string | null;
  /** Payload written to disk verbatim. */
  data: string;
  filename?: string;
  originalUrl?: string | null;
}

/**
 * File-based attachment storage (plan 332 Phase 2).
 *
 * The legacy `message_attachments.data` TEXT column held large payloads
 * (parsed document full text, base64 image chunks) inline, bloating the DB.
 * This store keeps only an index row in the core DB and writes the payload to
 * `{~/.duya}/attachments/<id>/<filename>`, mirroring Codex's
 * `attachments/<uuid>/` layout. `save` is idempotent: re-saving an existing id
 * returns the existing row and skips the file write.
 */
export class AttachmentStore {
  /** Migration id=10: create attachments. */
  static readonly migrations: Migration[] = [
    {
      id: 10,
      name: 'create_attachments',
      up: (db) => {
        db.exec(`
          CREATE TABLE attachments (
            id              TEXT PRIMARY KEY,
            message_id      TEXT,
            session_id      TEXT NOT NULL,
            attachment_type TEXT NOT NULL,
            mime_type       TEXT,
            file_path       TEXT NOT NULL,
            original_url    TEXT,
            created_at      INTEGER NOT NULL
          );
          CREATE INDEX idx_attach_session ON attachments(session_id);
          CREATE INDEX idx_attach_message ON attachments(message_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;
  private readonly rootDir: string;

  constructor(db: SqliteDatabase, rootDir: string) {
    this.db = db;
    this.rootDir = rootDir;
  }

  save(input: AttachmentSaveInput): CoreAttachment {
    const id = input.id ?? randomUUID();
    const existing = this.get(id);
    if (existing) return existing;

    const dir = path.join(this.rootDir, id);
    const filename = sanitizeFilename(input.filename ?? 'attachment');
    const filePath = path.join(dir, filename);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, input.data, 'utf-8');
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO attachments (
          id, message_id, session_id, attachment_type, mime_type, file_path,
          original_url, created_at
        ) VALUES (
          @id, @message_id, @session_id, @attachment_type, @mime_type, @file_path,
          @original_url, @created_at
        )`,
      )
      .run({
        id,
        message_id: input.messageId ?? null,
        session_id: input.sessionId,
        attachment_type: input.type,
        mime_type: input.mimeType ?? null,
        file_path: filePath,
        original_url: input.originalUrl ?? null,
        created_at: Date.now(),
      });
    return this.get(id)!;
  }

  get(id: string): CoreAttachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  /** All attachments for a session, oldest first, with payload read from file. */
  getForSession(sessionId: string): AttachmentWithData[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as AttachmentRow[];
    return rows.map(readAttachment);
  }

  /** All attachments for a message, oldest first, with payload read from file. */
  getForMessage(messageId: string): AttachmentWithData[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC')
      .all(messageId) as AttachmentRow[];
    return rows.map(readAttachment);
  }

  /** Delete an attachment (optional — used by rollback/cleanup). */
  delete(id: string): boolean {
    const att = this.get(id);
    if (!att) return false;
    try { fs.rmSync(path.dirname(att.filePath), { recursive: true, force: true }); } catch { /* best-effort */ }
    return this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes > 0;
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

interface GoalRow {
  id: string;
  session_id: string;
  goal_text: string | null;
  status: GoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
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

function rowToGoal(row: GoalRow): SessionGoal {
  return {
    id: row.id,
    sessionId: row.session_id,
    goalText: row.goal_text,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

interface SpawnEdgeRow {
  id: string;
  parent_session_id: string;
  child_session_id: string;
  spawn_turn_id: string | null;
  spawn_reason: string | null;
  spawn_type: string;
  spawned_at: number;
}

function rowToSpawnEdge(row: SpawnEdgeRow): SpawnEdge {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    spawnTurnId: row.spawn_turn_id,
    spawnReason: row.spawn_reason,
    spawnType: row.spawn_type,
    spawnedAt: row.spawned_at,
  };
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  session_id: string;
  attachment_type: string;
  mime_type: string | null;
  file_path: string;
  original_url: string | null;
  created_at: number;
}

function rowToAttachment(row: AttachmentRow): CoreAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    sessionId: row.session_id,
    attachmentType: row.attachment_type,
    mimeType: row.mime_type,
    filePath: row.file_path,
    originalUrl: row.original_url,
    createdAt: row.created_at,
  };
}

/** Read the payload file back into `data`. Missing file → empty-string fallback. */
function readAttachment(row: AttachmentRow): AttachmentWithData {
  let data = '';
  try {
    data = fs.readFileSync(row.file_path, 'utf-8');
  } catch {
    // graceful fallback — payload file missing (e.g. deleted by user)
  }
  return { ...rowToAttachment(row), data };
}

/** Strip path separators / traversal so a filename can never escape its dir. */
function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[/\\]/g, '_');
  return base || 'attachment';
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
