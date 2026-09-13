import * as ipcDbClient from '../ipc/db-client.js';

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
  createTask(task: Omit<Task, 'id'> & { id?: string }): Promise<Task>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null>;
  deleteTask(taskId: string): Promise<boolean>;
  claimTask(taskId: string, owner: string): Promise<ClaimTaskResult>;
  blockTask(fromTaskId: string, toTaskId: string): Promise<boolean>;
  getAgentStatuses(): Promise<AgentStatus[]>;
  unassignTeammateTasks(owner: string): Promise<UnassignTasksResult>;
}

// =============================================================================
// Row-to-Task conversion (shared by IPC store)
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

  async createTask(task: Omit<Task, 'id'> & { id?: string }): Promise<Task> {
    const ipc = getIpcClient()!;
    // Caller-supplied id is honored so tools (e.g. todo) can preserve
    // their own identity across re-issue. If the row already exists in
    // any session, fail loudly rather than silently overwriting it.
    const id = task.id ?? crypto.randomUUID();
    try {
      await ipc.taskDb.create({
        id,
        session_id: this.sessionId,
        subject: task.subject,
        description: task.description,
        status: task.status,
        active_form: task.activeForm,
        owner: task.owner,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new Error(`Task id "${id}" already exists. Pick a different id, or use the existing row's update path.`);
      }
      throw err;
    }
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
// No-op Task Store (CLI standalone mode)
// =============================================================================
// Plan 328 decision 9: CLI standalone mode abandons session persistence. The
// legacy `tasks` table lives in duya-core.db; the agent must not open it via a
// hidden second connection. Non-IPC writes are no-ops and reads return empty.

class NoopTaskStore implements TaskStore {
  constructor(private sessionId: string) {}

  async getTask(taskId: string): Promise<Task | null> {
    return null;
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }

  async createTask(task: Omit<Task, 'id'> & { id?: string }): Promise<Task> {
    return { id: task.id ?? 'unpersisted', ...task };
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    return null;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return false;
  }

  async claimTask(taskId: string, owner: string): Promise<ClaimTaskResult> {
    return { success: false, reason: 'task_not_found' };
  }

  async blockTask(fromTaskId: string, toTaskId: string): Promise<boolean> {
    return false;
  }

  async getAgentStatuses(): Promise<AgentStatus[]> {
    return [];
  }

  async unassignTeammateTasks(owner: string): Promise<UnassignTasksResult> {
    return { unassignedTasks: [], notificationMessage: '' };
  }
}

// =============================================================================
// TaskStore Factory
// =============================================================================

/**
 * SQLite surfaces primary-key / unique-constraint failures with a `code`
 * property of the form `SQLITE_CONSTRAINT_*`. The IPC layer wraps these
 * errors but preserves `code`, so this duck-typed check is enough.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

const storeCache = new Map<string, TaskStore>();

export function getDatabaseTaskStore(sessionId: string): TaskStore {
  if (USE_IPC_MODE) {
    return new IPCTaskStore(sessionId);
  }
  if (!storeCache.has(sessionId)) {
    storeCache.set(sessionId, new NoopTaskStore(sessionId));
  }
  return storeCache.get(sessionId)!;
}
