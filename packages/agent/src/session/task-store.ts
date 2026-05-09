import * as ipcDbClient from '../ipc/db-client.js';
import { getDb } from './db.js';

// =============================================================================
// IPC Mode Detection
// =============================================================================

const USE_IPC_MODE = process.env.DUYA_AGENT_MODE === 'true' && typeof process.send === 'function';

let ipcClient: typeof import('../ipc/db-client.js') | null = null;

function getIpcClient(): typeof ipcClient {
  if (USE_IPC_MODE && !ipcClient) {
    ipcClient = ipcDbClient;
  }
  return ipcClient;
}

// =============================================================================
// Task Types
// =============================================================================

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export type ClaimTaskResult = {
  success: boolean;
  reason?: 'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked';
  task?: Task;
  blockedByTasks?: string[];
};

export type UnassignTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>;
  notificationMessage: string;
};

export type AgentStatus = {
  agentId: string;
  status: 'idle' | 'busy';
  currentTasks: string[];
};

export interface TaskStore {
  getTask(taskId: string): Promise<Task | null>;
  listTasks(): Promise<Task[]>;
  createTask(task: Omit<Task, 'id'>): Promise<Task>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null>;
  deleteTask(taskId: string): Promise<boolean>;
  claimTask(taskId: string, owner: string): Promise<ClaimTaskResult>;
  blockTask(fromTaskId: string, toTaskId: string): Promise<boolean>;
  getAgentStatuses(): Promise<AgentStatus[]>;
  unassignTeammateTasks(owner: string): Promise<UnassignTasksResult>;
}

// =============================================================================
// Row-to-Task conversion
// =============================================================================

interface DbRow {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  active_form: string | null;
  owner: string | null;
  blocks: string;
  blocked_by: string;
  metadata: string;
}

function rowToTask(row: DbRow): Task {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    activeForm: row.active_form || undefined,
    owner: row.owner || undefined,
    blocks: JSON.parse(row.blocks || '[]'),
    blockedBy: JSON.parse(row.blocked_by || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

// =============================================================================
// IPC TaskStore Implementation
// =============================================================================

class IPCTaskStore implements TaskStore {
  constructor(private sessionId: string) {}

  async getTask(taskId: string): Promise<Task | null> {
    const ipc = getIpcClient()!;
    const result = await ipc.taskDb.get(taskId) as DbRow | null;
    if (!result) return null;
    return rowToTask(result);
  }

  async listTasks(): Promise<Task[]> {
    const ipc = getIpcClient()!;
    const results = await ipc.taskDb.getBySession(this.sessionId) as DbRow[];
    return results.map(rowToTask);
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const ipc = getIpcClient()!;
    const id = crypto.randomUUID();
    await ipc.taskDb.create({
      id,
      session_id: this.sessionId,
      subject: task.subject,
      description: task.description,
      active_form: task.activeForm,
      owner: task.owner,
    });
    const result = await this.getTask(id);
    if (!result) throw new Error('Failed to create task');
    return result;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const ipc = getIpcClient()!;
    await ipc.taskDb.update(taskId, { ...updates, session_id: this.sessionId });
    return this.getTask(taskId);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const ipc = getIpcClient()!;
    return await ipc.taskDb.delete(taskId) as boolean;
  }

  async claimTask(taskId: string, owner: string): Promise<ClaimTaskResult> {
    const ipc = getIpcClient()!;
    const rawResult = await ipc.taskDb.claim(taskId, owner) as Record<string, unknown>;
    if (!rawResult.success) {
      return {
        success: false,
        reason: rawResult.reason as ClaimTaskResult['reason'],
        blockedByTasks: rawResult.blockedByTasks as string[] | undefined,
      };
    }
    const row = rawResult.task as Record<string, unknown> | undefined;
    if (!row) return { success: false, reason: 'task_not_found' };
    return {
      success: true,
      task: rowToTask(row as unknown as DbRow),
    };
  }

  async blockTask(fromTaskId: string, toTaskId: string): Promise<boolean> {
    const ipc = getIpcClient()!;
    return await ipc.taskDb.block(fromTaskId, toTaskId) as boolean;
  }

  async getAgentStatuses(): Promise<AgentStatus[]> {
    const allTasks = await this.listTasks();
    const unresolvedByOwner = new Map<string, string[]>();
    for (const task of allTasks) {
      if (task.status !== 'completed' && task.owner) {
        const existing = unresolvedByOwner.get(task.owner) || [];
        existing.push(task.id);
        unresolvedByOwner.set(task.owner, existing);
      }
    }
    return Array.from(unresolvedByOwner.entries()).map(([owner, tasks]) => ({
      agentId: owner,
      status: 'busy' as const,
      currentTasks: tasks,
    }));
  }

  async unassignTeammateTasks(owner: string): Promise<UnassignTasksResult> {
    const ipc = getIpcClient()!;
    return await ipc.taskDb.unassignTeammate(this.sessionId, owner) as UnassignTasksResult;
  }
}

// =============================================================================
// Direct Task Store Implementation (uses shared getDb from session/db.ts)
// =============================================================================

class DirectTaskStore implements TaskStore {
  constructor(private sessionId: string) {}

  async getTask(taskId: string): Promise<Task | null> {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM tasks WHERE id = ? AND session_id = ?'
    ).get(taskId, this.sessionId) as DbRow | undefined;
    if (!row) return null;
    return rowToTask(row);
  }

  async listTasks(): Promise<Task[]> {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC'
    ).all(this.sessionId) as DbRow[];
    return rows.map(rowToTask);
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const db = getDb();
    const now = Date.now();
    const countResult = db.prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE session_id = ?'
    ).get(this.sessionId) as { count: number };
    const id = String(countResult.count + 1);

    db.prepare(`
      INSERT INTO tasks (id, session_id, subject, description, status, active_form, owner, blocks, blocked_by, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, this.sessionId, task.subject, task.description,
      task.status || 'pending', task.activeForm || null, task.owner || null,
      JSON.stringify(task.blocks || []), JSON.stringify(task.blockedBy || []),
      JSON.stringify(task.metadata || {}), now, now
    );

    const result = await this.getTask(id);
    if (!result) throw new Error('Failed to create task');
    return result;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const db = getDb();
    const now = Date.now();

    db.prepare(`
      UPDATE tasks SET
        subject = COALESCE(?, subject),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        active_form = COALESCE(?, active_form),
        owner = COALESCE(?, owner),
        blocks = COALESCE(?, blocks),
        blocked_by = COALESCE(?, blocked_by),
        metadata = COALESCE(?, metadata),
        updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(
      updates.subject ?? null, updates.description ?? null,
      updates.status ?? null, updates.activeForm ?? null, updates.owner ?? null,
      updates.blocks ? JSON.stringify(updates.blocks) : null,
      updates.blockedBy ? JSON.stringify(updates.blockedBy) : null,
      updates.metadata ? JSON.stringify(updates.metadata) : null,
      now, taskId, this.sessionId
    );

    return this.getTask(taskId);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const db = getDb();
    const result = db.prepare(
      'DELETE FROM tasks WHERE id = ? AND session_id = ?'
    ).run(taskId, this.sessionId);
    return result.changes > 0;
  }

  async claimTask(taskId: string, owner: string): Promise<ClaimTaskResult> {
    const db = getDb();
    const now = Date.now();

    const existingTask = await this.getTask(taskId);
    if (!existingTask) return { success: false, reason: 'task_not_found' };
    if (existingTask.owner && existingTask.owner !== owner) {
      return { success: false, reason: 'already_claimed', task: existingTask };
    }
    if (existingTask.status === 'completed') {
      return { success: false, reason: 'already_resolved', task: existingTask };
    }

    if (existingTask.blockedBy.length > 0) {
      const unresolvedIds = db.prepare(
        `SELECT id FROM tasks WHERE id IN (${existingTask.blockedBy.map(() => '?').join(',')}) AND status != 'completed'`
      ).all(...existingTask.blockedBy) as { id: string }[];
      if (unresolvedIds.length > 0) {
        return {
          success: false,
          reason: 'blocked',
          task: existingTask,
          blockedByTasks: unresolvedIds.map(r => r.id),
        };
      }
    }

    db.prepare(
      `UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = ? WHERE id = ? AND session_id = ?`
    ).run(owner, now, taskId, this.sessionId);

    const updated = await this.getTask(taskId);
    return { success: true, task: updated! };
  }

  async blockTask(fromTaskId: string, toTaskId: string): Promise<boolean> {
    const db = getDb();
    const now = Date.now();

    const [fromTask, toTask] = await Promise.all([this.getTask(fromTaskId), this.getTask(toTaskId)]);
    if (!fromTask || !toTask) return false;

    if (!fromTask.blocks.includes(toTaskId)) {
      db.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ? AND session_id = ?')
        .run(JSON.stringify([...fromTask.blocks, toTaskId]), now, fromTaskId, this.sessionId);
    }
    if (!toTask.blockedBy.includes(fromTaskId)) {
      db.prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ? AND session_id = ?')
        .run(JSON.stringify([...toTask.blockedBy, fromTaskId]), now, toTaskId, this.sessionId);
    }
    return true;
  }

  async getAgentStatuses(): Promise<AgentStatus[]> {
    const allTasks = await this.listTasks();
    const unresolvedByOwner = new Map<string, string[]>();
    for (const task of allTasks) {
      if (task.status !== 'completed' && task.owner) {
        const existing = unresolvedByOwner.get(task.owner) || [];
        existing.push(task.id);
        unresolvedByOwner.set(task.owner, existing);
      }
    }
    return Array.from(unresolvedByOwner.entries()).map(([ownerId, tasks]) => ({
      agentId: ownerId,
      status: 'busy' as const,
      currentTasks: tasks,
    }));
  }

  async unassignTeammateTasks(owner: string): Promise<UnassignTasksResult> {
    const db = getDb();
    const now = Date.now();

    const tasks = db.prepare(
      `SELECT id, subject FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).all(this.sessionId, owner) as { id: string; subject: string }[];

    if (tasks.length === 0) return { unassignedTasks: [], notificationMessage: '' };

    db.prepare(
      `UPDATE tasks SET owner = NULL, status = 'pending', updated_at = ? WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).run(now, this.sessionId, owner);

    const taskList = tasks.map(t => `#${t.id} "${t.subject}"`).join(', ');
    return {
      unassignedTasks: tasks.map(t => ({ id: t.id, subject: t.subject })),
      notificationMessage: `${owner} was terminated. ${tasks.length} task(s) were unassigned: ${taskList}.`,
    };
  }
}

// =============================================================================
// TaskStore Factory
// =============================================================================

const storeCache = new Map<string, TaskStore>();

export function getDatabaseTaskStore(sessionId: string): TaskStore {
  if (USE_IPC_MODE) {
    return new IPCTaskStore(sessionId);
  }
  if (!storeCache.has(sessionId)) {
    storeCache.set(sessionId, new DirectTaskStore(sessionId));
  }
  return storeCache.get(sessionId)!;
}
