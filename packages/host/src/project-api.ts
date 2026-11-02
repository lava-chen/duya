import type {
  HostProjectApiV1,
  HostProjectCreateInput,
  HostProjectPatch,
  HostProjectPathEntry,
  HostProjectRecord,
} from '@duya/agent-protocol/projects';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import {
  parseProjectPaths,
  serializeProjectPaths,
  type ProjectRow,
  type ProjectStore,
} from '@duya/data/project-store';

export class HostProjectApiError extends Error {
  constructor(readonly code: 'project_conflict', message: string) {
    super(message);
    this.name = 'HostProjectApiError';
  }
}

function toRecord(row: ProjectRow): HostProjectRecord {
  return {
    ...row,
    paths: parseProjectPaths(row.paths),
  };
}

function pathsToJson(paths: readonly HostProjectPathEntry[]): string {
  return serializeProjectPaths(paths.map(({ path, description }) => ({ path, description })));
}

/** Build the asynchronous project API over the Host-owned Data store. */
export function createHostProjectApi(
  projects: Pick<ProjectStore, 'list' | 'get' | 'insert' | 'update' | 'delete' | 'deleteBotsByProject' | 'bindCoordinatorSession' | 'listTaskLinks' | 'bindTask' | 'bindWorkSession'>,
  tasks?: Pick<CoreDataHostStores['tasks'], 'get'>,
): HostProjectApiV1 {
  return {
    async listProjects() {
      return projects.list().map(toRecord);
    },

    async getProject(projectId) {
      const row = projects.get(projectId);
      return row ? toRecord(row) : null;
    },

    async createProject(input: HostProjectCreateInput) {
      const firstPath = input.paths[0];
      if (!firstPath) throw new Error('At least one project path is required');
      try {
        const row = projects.insert({
          canonical_root: firstPath.path,
          name: input.name,
          description: input.description ?? null,
          paths: pathsToJson(input.paths),
          icon: input.icon ?? null,
          color: input.color ?? null,
        });
        return toRecord(row);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HostProjectApiError('project_conflict', 'A project already uses this canonical path');
        }
        throw error;
      }
    },

    async updateProject(projectId, patch: HostProjectPatch) {
      const existing = projects.get(projectId);
      if (!existing) return null;
      const paths = patch.paths;
      try {
        projects.update(projectId, {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.icon === undefined ? {} : { icon: patch.icon }),
          ...(patch.color === undefined ? {} : { color: patch.color }),
          ...(paths === undefined ? {} : {
            paths: pathsToJson(paths),
            canonical_root: paths[0]?.path ?? existing.canonical_root,
          }),
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HostProjectApiError('project_conflict', 'A project already uses this canonical path');
        }
        throw error;
      }
      const updated = projects.get(projectId);
      return updated ? toRecord(updated) : null;
    },

    async deleteProject(projectId) {
      if (!projects.get(projectId)) return false;
      projects.deleteBotsByProject(projectId);
      return projects.delete(projectId);
    },

    async bindCoordinatorSession(projectId, sessionId) {
      const row = projects.bindCoordinatorSession(projectId, sessionId);
      return row ? toRecord(row) : null;
    },

    async listProjectTasks(projectId) {
      if (!projects.get(projectId)) return [];
      return projects.listTaskLinks(projectId).map((link) => ({
        projectId: link.project_id,
        taskId: link.task_id,
        coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id,
        updatedAt: link.updated_at,
      }));
    },

    async bindProjectTask(projectId, taskId, coordinatorSessionId) {
      if (!projects.get(projectId)) throw new Error(`Project "${projectId}" does not exist`);
      if (!tasks?.get(taskId)) throw new Error(`Task "${taskId}" does not exist`);
      const link = projects.bindTask(projectId, taskId, coordinatorSessionId);
      return { projectId: link.project_id, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id, updatedAt: link.updated_at };
    },

    async bindWorkSession(projectId, taskId, workSessionId) {
      const link = projects.bindWorkSession(projectId, taskId, workSessionId);
      return link ? { projectId: link.project_id, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id, updatedAt: link.updated_at } : null;
    },
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
