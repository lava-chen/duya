/**
 * stores.test.ts — TaskStore + PermissionLedger + LockStore (plan 327 Phase 2).
 *
 * Coverage per plan:
 *  - TaskStore: CRUD, claim idempotency (same owner no error), block bidirectional
 *    consistency, unassign clears owner, getByOwner filter.
 *  - PermissionLedger: create→pending, resolve writes all fields, repeat resolve
 *    idempotent (resolved not overwritten), listPending returns only pending.
 *  - LockStore: acquire/renew/release/expired-reacquire/wrong-lockId-rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LockStore,
  PermissionLedger,
  TaskStore,
  type CoreTask,
  type PermissionRequest,
  type PermissionStatus,
  type TaskCreateInput,
} from '../stores';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('stores', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let tasks: TaskStore;
  let permissions: PermissionLedger;
  let locks: LockStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-stores-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of TaskStore.migrations) m.up(db);
    for (const m of PermissionLedger.migrations) m.up(db);
    for (const m of LockStore.migrations) m.up(db);
    tasks = new TaskStore(db);
    permissions = new PermissionLedger(db);
    locks = new LockStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ─── TaskStore ───

  describe('TaskStore', () => {
    function createInput(id: string, overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
      return {
        id,
        sessionId: 's1',
        subject: `subject-${id}`,
        description: `desc-${id}`,
        ...overrides,
      };
    }

    it('create + get round-trips all fields with defaults', () => {
      const task = tasks.create(createInput('t1'));
      expect(task.id).toBe('t1');
      expect(task.sessionId).toBe('s1');
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
      expect(task.activeForm).toBeNull();
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
      expect(task.metadata).toEqual({});
      expect(task.createdAt).toBe(task.updatedAt);

      const fetched = tasks.get('t1');
      expect(fetched).toEqual(task);
    });

    it('create stores activeForm and owner overrides', () => {
      const task = tasks.create(createInput('t2', { activeForm: 'building', owner: 'alice' }));
      expect(task.activeForm).toBe('building');
      expect(task.owner).toBe('alice');
    });

    it('get returns null for missing id', () => {
      expect(tasks.get('missing')).toBeNull();
    });

    it('getBySession returns tasks ordered by created_at ASC', () => {
      tasks.create(createInput('a'));
      // create at slightly different times to ensure stable order
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(100, 'a');
      tasks.create(createInput('b'));
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(200, 'b');
      const list = tasks.getBySession('s1');
      expect(list.map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('update patches subject/status/owner and bumps updated_at', () => {
      tasks.create(createInput('t3'));
      // createdAt is stamped at create; updatedAt is stamped later on update.
      // They may be equal within the same ms, so assert updatedAt >= createdAt.
      const updated = tasks.update('t3', { subject: 'new', status: 'in_progress', owner: 'bob' })!;
      expect(updated.subject).toBe('new');
      expect(updated.status).toBe('in_progress');
      expect(updated.owner).toBe('bob');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
    });

    it('update serializes blocks/blockedBy/metadata to JSON', () => {
      tasks.create(createInput('t4'));
      const updated = tasks.update('t4', {
        blocks: ['t5'],
        blockedBy: ['t6'],
        metadata: { priority: 'high' },
      })!;
      expect(updated.blocks).toEqual(['t5']);
      expect(updated.blockedBy).toEqual(['t6']);
      expect(updated.metadata).toEqual({ priority: 'high' });
    });

    it('update with no fields returns the existing task unchanged', () => {
      tasks.create(createInput('t7'));
      const before = tasks.get('t7');
      const after = tasks.update('t7', {});
      expect(after).toEqual(before);
    });

    it('delete removes a single task and returns true', () => {
      tasks.create(createInput('t8'));
      expect(tasks.delete('t8')).toBe(true);
      expect(tasks.get('t8')).toBeNull();
      expect(tasks.delete('t8')).toBe(false);
    });

    it('deleteBySession removes all tasks for the session', () => {
      tasks.create(createInput('a', { sessionId: 's1' }));
      tasks.create(createInput('b', { sessionId: 's1' }));
      tasks.create(createInput('c', { sessionId: 's2' }));
      tasks.deleteBySession('s1');
      expect(tasks.getBySession('s1')).toEqual([]);
      expect(tasks.getBySession('s2')).toHaveLength(1);
    });

    it('claim succeeds on a fresh pending task', () => {
      tasks.create(createInput('t9'));
      const result = tasks.claim('t9', 'alice');
      expect(result.success).toBe(true);
      expect(result.task!.owner).toBe('alice');
      expect(result.task!.status).toBe('in_progress');
    });

    it('claim is idempotent for the same owner (no error)', () => {
      tasks.create(createInput('t10'));
      tasks.claim('t10', 'alice');
      const second = tasks.claim('t10', 'alice');
      expect(second.success).toBe(true);
      expect(second.task!.owner).toBe('alice');
    });

    it('claim rejects when already claimed by another owner', () => {
      tasks.create(createInput('t11'));
      tasks.claim('t11', 'alice');
      const result = tasks.claim('t11', 'bob');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_claimed');
    });

    it('claim rejects when task is already completed', () => {
      tasks.create(createInput('t12'));
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('t12');
      const result = tasks.claim('t12', 'alice');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_resolved');
    });

    it('claim rejects when blocked by unresolved tasks', () => {
      tasks.create(createInput('blocker'));
      tasks.create(createInput('blocked'));
      tasks.block('blocker', 'blocked');
      const result = tasks.claim('blocked', 'alice');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('blocked');
      expect(result.blockedByTasks).toEqual(['blocker']);
    });

    it('claim succeeds when blockers are completed', () => {
      tasks.create(createInput('blocker'));
      tasks.create(createInput('blocked'));
      tasks.block('blocker', 'blocked');
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('blocker');
      const result = tasks.claim('blocked', 'alice');
      expect(result.success).toBe(true);
    });

    it('claim returns task_not_found for missing id', () => {
      const result = tasks.claim('missing', 'alice');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('task_not_found');
    });

    it('block maintains bidirectional edges and is idempotent', () => {
      tasks.create(createInput('a'));
      tasks.create(createInput('b'));
      expect(tasks.block('a', 'b')).toBe(true);
      // Second call is a no-op (no duplicate entries)
      expect(tasks.block('a', 'b')).toBe(true);
      const a = tasks.get('a')!;
      const b = tasks.get('b')!;
      expect(a.blocks).toEqual(['b']);
      expect(b.blockedBy).toEqual(['a']);
    });

    it('block returns false when either task is missing', () => {
      tasks.create(createInput('a'));
      expect(tasks.block('a', 'missing')).toBe(false);
      expect(tasks.block('missing', 'a')).toBe(false);
    });

    it('unassignTeammate clears owner + resets status for non-completed tasks', () => {
      tasks.create(createInput('a'));
      tasks.create(createInput('b'));
      tasks.claim('a', 'alice');
      tasks.claim('b', 'alice');
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('b');

      const result = tasks.unassignTeammate('s1', 'alice');
      expect(result.unassignedTasks.map((t) => t.id)).toEqual(['a']);
      expect(result.notificationMessage).toContain('alice was terminated');
      expect(result.notificationMessage).toContain('1 task(s)');

      const a = tasks.get('a')!;
      expect(a.owner).toBeNull();
      expect(a.status).toBe('pending');
      // Completed task b is untouched
      const b = tasks.get('b')!;
      expect(b.owner).toBe('alice');
      expect(b.status).toBe('completed');
    });

    it('unassignTeammate returns empty result when no tasks match', () => {
      tasks.create(createInput('a'));
      const result = tasks.unassignTeammate('s1', 'nobody');
      expect(result.unassignedTasks).toEqual([]);
      expect(result.notificationMessage).toBe('');
    });

    it('getByOwner returns non-completed tasks for an owner', () => {
      tasks.create(createInput('a'));
      tasks.create(createInput('b'));
      tasks.create(createInput('c'));
      tasks.claim('a', 'alice');
      tasks.claim('b', 'alice');
      tasks.claim('c', 'bob');
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('a');

      const owned = tasks.getByOwner('s1', 'alice');
      // 'a' is completed so it's excluded; 'c' belongs to bob
      expect(owned.map((t) => t.id)).toEqual(['b']);
    });
  });

  // ─── PermissionLedger ───

  describe('PermissionLedger', () => {
    function create(id: string, overrides: Partial<{
      sessionId: string | null;
      toolName: string;
      toolInput: Record<string, unknown> | null;
    }> = {}): PermissionRequest {
      return permissions.create({
        id,
        sessionId: overrides.sessionId !== undefined ? overrides.sessionId : 's1',
        toolName: overrides.toolName ?? 'BashTool',
        toolInput: overrides.toolInput !== undefined ? overrides.toolInput : { command: 'rm -rf /' },
      });
    }

    it('create inserts a pending request with toolInput JSON', () => {
      const req = create('p1', { toolInput: { command: 'ls' } });
      expect(req.id).toBe('p1');
      expect(req.status).toBe('pending');
      expect(req.toolName).toBe('BashTool');
      expect(req.toolInput).toEqual({ command: 'ls' });
      expect(req.decision).toBeNull();
      expect(req.resolvedAt).toBeNull();
      expect(req.createdAt).toBeTypeOf('number');

      const fetched = permissions.get('p1');
      expect(fetched).toEqual(req);
    });

    it('create accepts null sessionId and toolInput', () => {
      const req = create('p2', { sessionId: null, toolInput: null });
      expect(req.sessionId).toBeNull();
      expect(req.toolInput).toBeNull();
    });

    it('get returns null for missing id', () => {
      expect(permissions.get('missing')).toBeNull();
    });

    it('resolve writes status/decision/message/updatedPermissions/updatedInput and stamps resolved_at', () => {
      create('p3');
      const resolved = permissions.resolve('p3', {
        status: 'allow',
        message: 'approved by user',
        updatedPermissions: [{ tool: 'BashTool', mode: 'always_allow' }],
        updatedInput: { command: 'ls -la' },
      })!;
      expect(resolved.status).toBe('allow');
      expect(resolved.decision).toBe('allow'); // defaults to status
      expect(resolved.message).toBe('approved by user');
      expect(resolved.updatedPermissions).toEqual([{ tool: 'BashTool', mode: 'always_allow' }]);
      expect(resolved.updatedInput).toEqual({ command: 'ls -la' });
      expect(resolved.resolvedAt).toBeTypeOf('number');
    });

    it('resolve accepts explicit decision override', () => {
      create('p4');
      const resolved = permissions.resolve('p4', {
        status: 'allow',
        decision: 'user_override',
      })!;
      expect(resolved.decision).toBe('user_override');
    });

    it('resolve is idempotent — already-resolved requests are returned unchanged', () => {
      create('p5');
      const first = permissions.resolve('p5', { status: 'deny', message: 'first' })!;
      const firstResolvedAt = first.resolvedAt;
      const second = permissions.resolve('p5', { status: 'allow', message: 'second' })!;
      expect(second.status).toBe('deny');
      expect(second.message).toBe('first');
      expect(second.resolvedAt).toBe(firstResolvedAt);
    });

    it('resolve returns null for missing id', () => {
      expect(permissions.resolve('missing', { status: 'allow' })).toBeNull();
    });

    it('listPending returns only pending requests', () => {
      create('a');
      create('b');
      create('c');
      permissions.resolve('b', { status: 'allow' });
      permissions.resolve('c', { status: 'deny' });
      const pending = permissions.listPending();
      expect(pending.map((r) => r.id)).toEqual(['a']);
    });

    it('listPending filters by sessionId', () => {
      create('a', { sessionId: 's1' });
      create('b', { sessionId: 's2' });
      const pendingS1 = permissions.listPending('s1');
      expect(pendingS1.map((r) => r.id)).toEqual(['a']);
    });

    it('listPending returns all pending when no sessionId given', () => {
      create('a', { sessionId: 's1' });
      create('b', { sessionId: 's2' });
      const all = permissions.listPending();
      expect(all.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });

    it('listBySession returns all requests for a session ordered by created_at ASC', () => {
      create('a', { sessionId: 's1' });
      create('b', { sessionId: 's1' });
      create('c', { sessionId: 's2' });
      db.prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?').run(100, 'a');
      db.prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?').run(200, 'b');
      const list = permissions.listBySession('s1');
      expect(list.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('handles all PermissionStatus values', () => {
      const statuses: PermissionStatus[] = ['pending', 'allow', 'deny', 'timeout', 'aborted'];
      for (const status of statuses) {
        const id = `p-${status}`;
        create(id);
        if (status !== 'pending') {
          permissions.resolve(id, { status });
        }
        expect(permissions.get(id)!.status).toBe(status);
      }
    });
  });

  // ─── LockStore ───

  describe('LockStore', () => {
    it('acquire succeeds on a fresh session', () => {
      expect(locks.acquire('s1', 'lock-1', 'alice')).toBe(true);
      expect(locks.isLocked('s1')).toBe(true);
    });

    it('renew succeeds for the holder and returns false for non-holders', () => {
      locks.acquire('s1', 'lock-1', 'alice');
      expect(locks.renew('s1', 'lock-1', 60)).toBe(true);
      expect(locks.renew('s1', 'wrong-lock', 60)).toBe(false);
      expect(locks.renew('missing', 'lock-1', 60)).toBe(false);
    });

    it('release succeeds for the holder and returns false for non-holders', () => {
      locks.acquire('s1', 'lock-1', 'alice');
      expect(locks.release('s1', 'wrong-lock')).toBe(false);
      expect(locks.release('s1', 'lock-1')).toBe(true);
      expect(locks.isLocked('s1')).toBe(false);
      expect(locks.release('s1', 'lock-1')).toBe(false);
    });

    it('acquire fails when an un-expired lock with a different lockId is held', () => {
      locks.acquire('s1', 'lock-1', 'alice');
      expect(locks.acquire('s1', 'lock-2', 'bob')).toBe(false);
      // Original holder still owns the lock
      expect(locks.isLocked('s1')).toBe(true);
    });

    it('acquire re-acquires after the existing lock expires', () => {
      locks.acquire('s1', 'lock-1', 'alice', 1); // 1s TTL
      // Force expiry
      db.prepare('UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ?').run(Date.now() - 1, 's1');
      expect(locks.acquire('s1', 'lock-2', 'bob')).toBe(true);
    });

    it('isLocked reaps expired locks as a side effect', () => {
      locks.acquire('s1', 'lock-1', 'alice', 1);
      db.prepare('UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ?').run(Date.now() - 1, 's1');
      expect(locks.isLocked('s1')).toBe(false);
      // Row was reaped
      const row = db.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?').get('s1');
      expect(row).toBeUndefined();
    });

    it('acquire can re-acquire with the same lockId (re-entrancy via UPSERT)', () => {
      locks.acquire('s1', 'lock-1', 'alice');
      // Same lockId, different owner — succeeds (re-acquire by new owner)
      expect(locks.acquire('s1', 'lock-1', 'bob')).toBe(true);
      const row = db.prepare('SELECT owner FROM session_runtime_locks WHERE session_id = ?').get('s1') as { owner: string };
      expect(row.owner).toBe('bob');
    });
  });
});
