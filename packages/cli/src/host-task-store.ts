import type {
  HostTaskApiV1,
  SessionId,
  TaskId,
  TaskStore,
  TaskUpdateInput,
} from '@duya/agent-protocol';

/** Bind the versioned Host task API to the session-scoped agent store port. */
export function createHostTaskStore(api: HostTaskApiV1, sessionId: string): TaskStore {
  const hostSessionId = sessionId as SessionId;
  return {
    getTask: (taskId) => api.getTask(taskId as TaskId),
    listTasks: () => api.listTasks(hostSessionId),
    createTask: (task) => api.createTask(hostSessionId, task),
    updateTask: (taskId, updates: TaskUpdateInput) => api.updateTask(taskId as TaskId, updates),
    deleteTask: (taskId) => api.deleteTask(taskId as TaskId),
    claimTask: (taskId, owner) => api.claimTask(taskId as TaskId, owner),
    blockTask: (fromTaskId, toTaskId) => api.blockTasks(fromTaskId as TaskId, toTaskId as TaskId),
    getAgentStatuses: () => api.getAgentStatuses(hostSessionId),
    unassignTeammateTasks: (owner) => api.unassignTeammateTasks(hostSessionId, owner),
  };
}
