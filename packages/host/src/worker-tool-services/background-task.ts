import type { BackgroundTaskPort } from '@duya/capabilities/background-task-tool';
import { getBashTaskRegistry, type BashTaskRegistry } from '../managed-shell/task-registry.js';
import { getBackgroundAgentLifecycle, type BackgroundAgentLifecycle } from '../worker-subagents/background-lifecycle.js';

export interface WorkerBackgroundTaskSources {
  getAgentLifecycle(): Pick<BackgroundAgentLifecycle, 'getSnapshot' | 'getAll' | 'tryKill'>;
  getShellRegistry(): Pick<BashTaskRegistry, 'getTask' | 'listTasks' | 'readOutput' | 'stopTask'>;
}

const defaultSources: WorkerBackgroundTaskSources = {
  getAgentLifecycle: getBackgroundAgentLifecycle,
  getShellRegistry: getBashTaskRegistry,
};

/** Binds Capability task tools to the worker's Host-owned lifecycle registries. */
export function createWorkerBackgroundTaskPort(sources: WorkerBackgroundTaskSources = defaultSources): BackgroundTaskPort {
  // The spawn receipt names two ids: task_id (this registry's key) and
  // subagent_id (the child's session id, what `resume_from` accepts). The
  // model regularly reaches for the receipt's FIRST id, so a lookup that
  // misses the task-id key falls back to matching the session id before
  // answering not_found — otherwise the parent concludes the child was lost.
  const resolveAgentTask = (taskId: string) => {
    const lifecycle = sources.getAgentLifecycle();
    const direct = lifecycle.getSnapshot(taskId);
    if (direct) return direct;
    const all = lifecycle.getAll();
    return all.find((task) => task.subAgentSessionId === taskId);
  };
  return {
    getAgentTask(taskId) {
      const task = resolveAgentTask(taskId);
      if (!task) return undefined;
      return {
        taskId: task.taskId,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
        ...(task.result === undefined
          ? {}
          : {
              result: {
                content: task.result.content.map((block) => ({
                  type: block.type,
                  ...('text' in block && typeof block.text === 'string' ? { text: block.text } : {}),
                })),
              },
            }),
      };
    },
    listAgentTasks() {
      return sources.getAgentLifecycle().getAll().map((task) => ({ taskId: task.taskId }));
    },
    tryKillAgentTask(taskId) {
      const resolved = resolveAgentTask(taskId);
      return sources.getAgentLifecycle().tryKill(resolved?.taskId ?? taskId, 'user_kill');
    },
    getShellTask(taskId) {
      const task = sources.getShellRegistry().getTask(taskId);
      if (!task) return undefined;
      return {
        id: task.id,
        pid: task.pid,
        status: task.status,
        ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
        ...(task.error === undefined ? {} : { error: task.error }),
      };
    },
    listShellTasks() {
      return sources.getShellRegistry().listTasks().map((task) => ({ id: task.id }));
    },
    readShellOutput(taskId, maxBytes) {
      return sources.getShellRegistry().readOutput(taskId, maxBytes);
    },
    stopShellTask(taskId) {
      return sources.getShellRegistry().stopTask(taskId);
    },
  };
}
