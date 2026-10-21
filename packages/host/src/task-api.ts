import { randomUUID } from 'node:crypto';
import type {
  AgentTaskStatus,
  HostTaskApiV1,
  SessionId,
  Task,
  TaskClaimResult,
  TaskCreateInput,
  TaskId,
  TaskStatus,
  TaskUpdateInput,
  UnassignTeammateTasksResult,
} from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

export class HostTaskApiError extends Error {
  constructor(readonly code: 'task_conflict', message: string) {
    super(message);
    this.name = 'HostTaskApiError';
  }
}

type StoredTask = NonNullable<ReturnType<CoreDataHostStores['tasks']['get']>>;

function toProtocolTask(task: StoredTask): Task {
  return {
    id: task.id as TaskId,
    sessionId: task.sessionId as SessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    subject: task.subject,
    description: task.description,
    status: task.status as TaskStatus,
    ...(task.activeForm === null ? {} : { activeForm: task.activeForm }),
    ...(task.owner === null ? {} : { owner: task.owner }),
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    metadata: task.metadata,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Build the transport-neutral task service over the Host-owned task store. */
export function createHostTaskApi(
  stores: Pick<CoreDataHostStores, 'tasks'>,
): HostTaskApiV1 {
  return {
    async getTask(taskId) {
      const task = stores.tasks.get(taskId);
      return task ? toProtocolTask(task) : null;
    },

    async listTasks(sessionId) {
      return stores.tasks.getBySession(sessionId).map(toProtocolTask);
    },

    async listTasksByOwner(sessionId, owner) {
      return stores.tasks.getByOwner(sessionId, owner).map(toProtocolTask);
    },

    async createTask(sessionId, input: TaskCreateInput) {
      const id = (input.id ?? randomUUID()) as TaskId;
      try {
        const task = stores.tasks.create({
          id,
          sessionId,
          subject: input.subject,
          description: input.description,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
          ...(input.owner === undefined ? {} : { owner: input.owner }),
          blocks: input.blocks,
          blockedBy: input.blockedBy,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
        return toProtocolTask(task);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HostTaskApiError('task_conflict', `Task id "${id}" already exists`);
        }
        throw error;
      }
    },

    async updateTask(taskId, updates: TaskUpdateInput) {
      const task = stores.tasks.update(taskId, updates);
      return task ? toProtocolTask(task) : null;
    },

    async deleteTask(taskId) {
      return stores.tasks.delete(taskId);
    },

    async deleteTasksBySession(sessionId: SessionId) {
      stores.tasks.deleteBySession(sessionId);
    },

    async claimTask(taskId, owner): Promise<TaskClaimResult> {
      const result = stores.tasks.claim(taskId, owner);
      return {
        success: result.success,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.task === undefined ? {} : { task: toProtocolTask(result.task) }),
        ...(result.blockedByTasks === undefined ? {} : { blockedByTasks: result.blockedByTasks as TaskId[] }),
      };
    },

    async blockTasks(fromTaskId, toTaskId) {
      return stores.tasks.block(fromTaskId, toTaskId);
    },

    async getAgentStatuses(sessionId): Promise<AgentTaskStatus[]> {
      const tasks = stores.tasks.getBySession(sessionId);
      const unresolvedByOwner = new Map<string, TaskId[]>();
      for (const task of tasks) {
        if (task.status === 'completed' || !task.owner) continue;
        const owned = unresolvedByOwner.get(task.owner) ?? [];
        owned.push(task.id as TaskId);
        unresolvedByOwner.set(task.owner, owned);
      }
      return Array.from(unresolvedByOwner, ([agentId, currentTasks]) => ({
        agentId,
        status: 'busy',
        currentTasks,
      }));
    },

    async unassignTeammateTasks(
      sessionId,
      owner,
    ): Promise<UnassignTeammateTasksResult> {
      const result = stores.tasks.unassignTeammate(sessionId, owner);
      return {
        unassignedTasks: result.unassignedTasks.map((task) => ({
          ...task,
          id: task.id as TaskId,
        })),
        notificationMessage: result.notificationMessage,
      };
    },
  };
}
