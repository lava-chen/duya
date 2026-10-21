import type { SessionId, TaskId } from './primitives.js';

/** Status vocabulary for a session's persisted todo task. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** Transport-neutral task shape shared by the worker, host, and clients. */
export interface Task {
  id: TaskId;
  /** Persistence metadata included by Host APIs for compatibility projections. */
  sessionId?: SessionId;
  createdAt?: number;
  updatedAt?: number;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export type TaskCreateInput = Omit<Task, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'> & { id?: string };
export type TaskUpdateInput = Partial<
  Omit<Task, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'activeForm' | 'owner'>
> & {
  activeForm?: string | null;
  owner?: string | null;
};

export type TaskClaimResult = {
  success: boolean;
  reason?: 'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked';
  task?: Task;
  blockedByTasks?: string[];
};

export type UnassignTeammateTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>;
  notificationMessage: string;
};

export type AgentTaskStatus = {
  agentId: string;
  status: 'idle' | 'busy';
  currentTasks: string[];
};

/** Process-neutral task persistence port used by the agent and Host adapters. */
export interface TaskStore {
  getTask(taskId: string): Promise<Task | null>;
  listTasks(): Promise<Task[]>;
  createTask(task: TaskCreateInput): Promise<Task>;
  updateTask(taskId: string, updates: TaskUpdateInput): Promise<Task | null>;
  deleteTask(taskId: string): Promise<boolean>;
  claimTask(taskId: string, owner: string): Promise<TaskClaimResult>;
  blockTask(fromTaskId: string, toTaskId: string): Promise<boolean>;
  getAgentStatuses(): Promise<AgentTaskStatus[]>;
  unassignTeammateTasks(owner: string): Promise<UnassignTeammateTasksResult>;
}

/** Versioned cross-process task API. Session-scoped operations carry the session explicitly. */
export interface HostTaskApiV1 {
  getTask(taskId: string): Promise<Task | null>;
  listTasks(sessionId: SessionId): Promise<Task[]>;
  listTasksByOwner(sessionId: SessionId, owner: string): Promise<Task[]>;
  createTask(sessionId: SessionId, task: TaskCreateInput): Promise<Task>;
  updateTask(taskId: string, updates: TaskUpdateInput): Promise<Task | null>;
  deleteTask(taskId: string): Promise<boolean>;
  deleteTasksBySession(sessionId: SessionId): Promise<void>;
  claimTask(taskId: string, owner: string): Promise<TaskClaimResult>;
  blockTasks(fromTaskId: string, toTaskId: string): Promise<boolean>;
  getAgentStatuses(sessionId: SessionId): Promise<AgentTaskStatus[]>;
  unassignTeammateTasks(sessionId: SessionId, owner: string): Promise<UnassignTeammateTasksResult>;
}
