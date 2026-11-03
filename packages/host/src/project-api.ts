import type {
  HostProjectApiV1,
  HostProjectCreateInput,
  HostProjectPatch,
  HostProjectPathEntry,
  HostProjectRecord,
  ProjectContinuitySnapshot,
  ProjectDecision,
  ProjectMemory,
  ProjectContinuityState,
  HostProjectState,
  HostProjectTaskState,
  HostProjectWorkSession,
} from '@duya/agent-protocol/projects';
import type { Task } from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import {
  parseProjectPaths,
  serializeProjectPaths,
  type ProjectRow,
  type ProjectStore,
  type ProjectTaskLinkRow,
} from '@duya/data/project-store';
import { validateProjectMemoryKey } from '@duya/memory';
import { buildProjectContext } from './project/context.js';

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

/**
 * The session facts a project state projection needs.
 *
 * A project has two kinds of working session: the ones its coordinator
 * spawned (the spawn lineage) and the ones bound to a project task. Both are
 * read here, and only here — the projection does not ask a client to
 * assemble them.
 */
export interface HostProjectSessionScope {
  readonly sessions: Pick<CoreDataHostStores['sessions'], 'get'>;
  readonly spawnEdges: Pick<CoreDataHostStores['spawnEdges'], 'listChildren'>;
}

/** Build the asynchronous project API over the Host-owned Data store. */
export function createHostProjectApi(
  projects: Pick<ProjectStore, 'list' | 'get' | 'insert' | 'update' | 'delete' | 'deleteBotsByProject' | 'bindCoordinatorSession' | 'listTaskLinks' | 'bindTask' | 'bindWorkSession' | 'setTaskAcceptance' | 'getContinuityState' | 'updateContinuityState' | 'listDecisions' | 'upsertDecision' | 'listMemories' | 'upsertMemory' | 'listMemoryHistory' | 'listDecisionHistory' | 'appendActivity' | 'listActivity' | 'listRecentActivity'>,
  tasks?: Pick<CoreDataHostStores['tasks'], 'get'>,
  scope?: HostProjectSessionScope,
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
        acceptanceStatus: link.acceptance_status,
      }));
    },

    async bindProjectTask(projectId, taskId, coordinatorSessionId) {
      if (!projects.get(projectId)) throw new Error(`Project "${projectId}" does not exist`);
      if (!tasks?.get(taskId)) throw new Error(`Task "${taskId}" does not exist`);
      const link = projects.bindTask(projectId, taskId, coordinatorSessionId);
      return { projectId: link.project_id, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id, updatedAt: link.updated_at, acceptanceStatus: link.acceptance_status };
    },

    async bindWorkSession(projectId, taskId, workSessionId) {
      const link = projects.bindWorkSession(projectId, taskId, workSessionId);
      return link ? { projectId: link.project_id, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id, updatedAt: link.updated_at, acceptanceStatus: link.acceptance_status } : null;
    },

    async getProjectContinuity(projectId, options = {}) {
      const project = projects.get(projectId);
      if (!project) return null;
      const projectRecord = toRecord(project);
      const links = projects.listTaskLinks(projectId);
      const taskRows = await Promise.all(links.map(async (link) => ({
        link: { projectId, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
          workSessionId: link.work_session_id, updatedAt: link.updated_at, acceptanceStatus: link.acceptance_status },
        task: tasks ? toProjectTask(await tasks.get(link.task_id)) : null,
      })));
      const stateRow = projects.getContinuityState(projectId);
      const decisions = projects.listDecisions(projectId).map((row) => ({
        key: row.decision_key, content: row.content, status: row.status, revision: row.revision,
        source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at,
      }));
      const memories = projects.listMemories(projectId, 100).map((row) => ({
        key: row.memory_key, content: row.content, status: row.status, revision: row.revision,
        source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at,
      }));
      const activityRows = projects.listActivity(projectId, options.afterCursor ?? 0, options.limit ?? 50);
      const activity = activityRows.map((row) => ({
        cursor: row.event_id, type: row.event_type, taskId: row.task_id, sessionId: row.session_id,
        runId: row.run_id, source: { type: row.source_type, id: row.source_id },
        payload: parseJsonObject(row.payload), createdAt: row.created_at,
      }));
      const transcriptRefs = new Map<string, { sessionId: string; role: 'coordinator' | 'work'; taskId?: string }>();
      if (projectRecord.coordinator_session_id) transcriptRefs.set(projectRecord.coordinator_session_id, { sessionId: projectRecord.coordinator_session_id, role: 'coordinator' });
      for (const { link } of taskRows) if (link.workSessionId) transcriptRefs.set(link.workSessionId, { sessionId: link.workSessionId, role: 'work', taskId: link.taskId });
      const state: ProjectContinuityState | null = stateRow ? {
        revision: stateRow.revision, currentState: stateRow.current_state, nextStep: stateRow.next_step,
        source: { type: stateRow.source_type, id: stateRow.source_id }, updatedAt: stateRow.updated_at,
      } : null;
      return { project: projectRecord, state, tasks: taskRows, decisions, memories, activity,
        nextCursor: activityRows.at(-1)?.event_id ?? (options.afterCursor ?? 0), transcriptRefs: [...transcriptRefs.values()] } satisfies ProjectContinuitySnapshot;
    },

    async getProjectContext(projectId, taskId, maxCharacters) {
      const snapshot = await this.getProjectContinuity(projectId, { limit: 100 });
      if (!snapshot) return null;
      return buildProjectContext({
        snapshot,
        recentActivity: projects.listRecentActivity(projectId, 10),
        ...(taskId === undefined ? {} : { taskId }),
        ...(maxCharacters === undefined ? {} : { maxCharacters }),
      });
    },

    async updateProjectState(input) {
      assertProjectSource(input.source);
      const result = projects.updateContinuityState({ projectId: input.projectId, expectedRevision: input.expectedRevision,
        currentState: bounded(input.currentState, 8000), nextStep: bounded(input.nextStep, 2000), sourceType: input.source.type, sourceId: input.source.id });
      if (!result) return null;
      return { revision: result.revision, currentState: input.currentState, nextStep: input.nextStep,
        source: input.source, updatedAt: result.updatedAt };
    },

    async updateProjectDecision(input) {
      assertProjectSource(input.source); assertMemoryKey(input.key);
      if (input.status === 'accepted' && input.source.type !== 'user_message') throw new Error('Only an explicit user decision can accept a project decision');
      const row = projects.upsertDecision({ project_id: input.projectId, decision_key: input.key, content: bounded(input.content, 4000),
        status: input.status, expectedRevision: input.expectedRevision, source_type: input.source.type, source_id: input.source.id });
      if (!row) return null;
      return { key: row.decision_key, content: row.content, status: row.status, revision: row.revision,
        source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at } satisfies ProjectDecision;
    },

    async updateProjectMemory(input) {
      assertProjectSource(input.source); assertMemoryKey(input.key);
      if (input.status === 'active' && input.source.type !== 'user_message') throw new Error('A project memory candidate needs explicit user confirmation before activation');
      const row = projects.upsertMemory({ project_id: input.projectId, memory_key: input.key, content: bounded(input.content, 8000),
        status: input.status, expectedRevision: input.expectedRevision, source_type: input.source.type, source_id: input.source.id });
      if (!row) return null;
      return { key: row.memory_key, content: row.content, status: row.status, revision: row.revision,
        source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at } satisfies ProjectMemory;
    },

    async updateProjectTaskAcceptance(input) {
      assertProjectSource(input.source);
      if (input.source.type !== 'user_message') throw new Error('Task acceptance must cite an explicit user message');
      const link = projects.setTaskAcceptance(input.projectId, input.taskId, input.status, input.source.type, input.source.id);
      if (!link) return null;
      return { projectId: link.project_id, taskId: link.task_id, coordinatorSessionId: link.coordinator_session_id,
        workSessionId: link.work_session_id, updatedAt: link.updated_at, acceptanceStatus: link.acceptance_status };
    },

    async listProjectMemoryHistory(projectId, key, limit = 20) {
      if (!projects.get(projectId)) return [];
      return projects.listMemoryHistory(projectId, key, limit).map((row) => ({ key: row.memory_key, content: row.content,
        status: row.status, revision: row.revision, source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at }));
    },

    async listProjectDecisionHistory(projectId, key, limit = 20) {
      if (!projects.get(projectId)) return [];
      return projects.listDecisionHistory(projectId, key, limit).map((row) => ({ key: row.decision_key, content: row.content,
        status: row.status, revision: row.revision, source: { type: row.source_type, id: row.source_id }, updatedAt: row.updated_at }));
    },

    async getProjectState(projectId) {
      const row = projects.get(projectId);
      if (!row) return null;

      // The links are the project's own record of what belongs to it. A link
      // whose task row is gone is still reported: the binding is a fact, and
      // hiding it would make the projection look tidier than the database is.
      // A link table that cascades on the task deletes the link with it, and
      // this branch is only reached on a database created before that
      // foreign key existed.
      const links = projects.listTaskLinks(projectId);
      const taskStates: HostProjectTaskState[] = links.map((link) => {
        const task = tasks?.get(link.task_id) ?? null;
        return {
          taskId: link.task_id,
          subject: task?.subject ?? '',
          description: task?.description ?? '',
          status: task?.status ?? 'unknown',
          activeForm: task?.activeForm ?? null,
          owner: task?.owner ?? null,
          blocks: task?.blocks ?? [],
          blockedBy: task?.blockedBy ?? [],
          coordinatorSessionId: link.coordinator_session_id,
          workSessionId: link.work_session_id,
          updatedAt: task?.updatedAt ?? link.updated_at,
        };
      });

      return {
        project: toRecord(row),
        coordinatorSessionId: row.coordinator_session_id,
        tasks: taskStates,
        workSessions: collectWorkSessions(row, links, scope),
        observedAt: Date.now(),
      };
    },
  };
}

function assertProjectSource(source: { type: string; id: string }): void {
  if (!source || !/^(user_message|session|run|task|transcript|worker_result)$/.test(source.type) || !source.id?.trim()) throw new Error('A recognized source reference is required');
}
function assertMemoryKey(key: string): void { if (!validateProjectMemoryKey(key)) throw new Error('Invalid project memory key'); }
function bounded(value: string, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function parseJsonObject(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function toProjectTask(task: Awaited<ReturnType<NonNullable<Pick<CoreDataHostStores['tasks'], 'get'>['get']>>> | null): Task | null {
  if (!task) return null;
  const status = task.status === 'completed' || task.status === 'in_progress' ? task.status : 'pending';
  return { id: task.id, sessionId: task.sessionId, createdAt: task.createdAt, updatedAt: task.updatedAt,
    subject: task.subject, description: task.description, status,
    ...(task.activeForm ? { activeForm: task.activeForm } : {}), ...(task.owner ? { owner: task.owner } : {}),
    blocks: task.blocks, blockedBy: task.blockedBy, metadata: task.metadata };
}

/**
 * The working sessions of a project.
 *
 * Two sources, and the order matters: a session the coordinator spawned and a
 * session bound to a project task can be the same session, and the binding is
 * the stronger fact — it is the one that says WHICH task the session works
 * on. So the binding is applied last and replaces the spawned entry.
 */
function collectWorkSessions(
  row: ProjectRow,
  links: readonly ProjectTaskLinkRow[],
  scope: HostProjectSessionScope | undefined,
): HostProjectWorkSession[] {
  if (!scope) return [];
  const bySession = new Map<string, HostProjectWorkSession>();

  const coordinatorSessionId = row.coordinator_session_id;
  if (coordinatorSessionId) {
    for (const edge of scope.spawnEdges.listChildren(coordinatorSessionId)) {
      const session = scope.sessions.get(edge.childSessionId);
      if (!session || session.status === 'deleted') continue;
      bySession.set(session.id, {
        sessionId: session.id,
        title: session.title,
        workingDirectory: session.workingDirectory,
        status: session.status,
        updatedAt: session.updatedAt,
        taskId: null,
        origin: 'spawned',
      });
    }
  }

  for (const link of links) {
    if (!link.work_session_id) continue;
    const session = scope.sessions.get(link.work_session_id);
    if (!session || session.status === 'deleted') continue;
    bySession.set(session.id, {
      sessionId: session.id,
      title: session.title,
      workingDirectory: session.workingDirectory,
      status: session.status,
      updatedAt: session.updatedAt,
      taskId: link.task_id,
      origin: 'bound',
    });
  }

  return [...bySession.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
