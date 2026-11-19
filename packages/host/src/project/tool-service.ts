/**
 * tool-service.ts — the Host half of the project tool.
 *
 * The capability asks in project terms; this service turns those requests into
 * the existing `HostProjectApiV1` calls. Two rules are enforced here rather
 * than in the worker:
 *
 *   1. The project is resolved from the caller's durable Coordinator binding,
 *      never from a worker-supplied project id.
 *   2. The tool surface is read-only. It returns the Task and Activity
 *      projection; the durable project rows stay under the Host and the user.
 */

import type {
  HostProjectApiV1,
  ProjectActivity,
  ProjectContinuitySnapshot,
} from '@duya/agent-protocol/projects';
import type { ProjectStore } from '@duya/data/project-store';
import type {
  ProjectToolActivity,
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolSnapshot,
} from '@duya/capabilities/project';

import type { ProjectSessionPromptContext } from './context.js';

const PROJECT_TOOL_ACTIONS: ReadonlySet<string> = new Set(['get']);

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 100;
const DEFAULT_CONTEXT_CHARACTERS = 8_000;

export interface ProjectToolServiceStores {
  readonly projects: Pick<ProjectStore, 'getByCoordinatorSession' | 'getTaskLinkByWorkSession'>;
}

export interface ProjectToolServiceOptions {
  readonly stores: ProjectToolServiceStores;
  readonly projectApi: Pick<
    HostProjectApiV1,
    'getProjectContinuity' | 'getProjectContext'
  >;
}

export interface ProjectToolService {
  /** Read-only worker assembly input; identity comes from the transport. */
  getSessionContext(callerSessionId: string): Promise<ProjectSessionPromptContext | null>;
  /**
   * Serve one project tool call. `callerSessionId` comes from the trusted
   * transport, never from the tool payload.
   */
  dispatch(input: {
    readonly action: string;
    readonly payload: Record<string, unknown>;
    readonly callerSessionId: string;
  }): Promise<ProjectToolOperation<ProjectToolPayload>>;
}

export function createProjectToolService(options: ProjectToolServiceOptions): ProjectToolService {
  const { stores, projectApi } = options;

  return {
    async getSessionContext(callerSessionId) {
      const coordinator = stores.projects.getByCoordinatorSession(callerSessionId);
      const link = coordinator ? null : stores.projects.getTaskLinkByWorkSession(callerSessionId);
      const projectId = coordinator?.project_id ?? link?.project_id;
      if (!projectId) return null;
      const context = await projectApi.getProjectContext(projectId, link?.task_id, DEFAULT_CONTEXT_CHARACTERS);
      if (!context) throw new Error('Bound project context unavailable');
      return { ...context, projectId, role: coordinator ? 'coordinator' : 'work', taskId: link?.task_id ?? null };
    },
    async dispatch({ action, payload, callerSessionId }) {
      if (!PROJECT_TOOL_ACTIONS.has(action)) {
        return refuse(`unsupported_action:${action}`);
      }
      const project = stores.projects.getByCoordinatorSession(callerSessionId);
      if (project === null) return refuse('not_project_coordinator');
      const projectId = project.project_id;

      const afterCursor = readInteger(payload.afterCursor, 0, Number.MAX_SAFE_INTEGER);
      if (afterCursor === 'invalid') return refuse('invalid_afterCursor');
      const limit = readInteger(payload.limit, 1, MAX_ACTIVITY_LIMIT);
      if (limit === 'invalid') return refuse('invalid_limit');
      const snapshot = await projectApi.getProjectContinuity(projectId, {
        ...(afterCursor === undefined ? {} : { afterCursor }),
        limit: limit ?? DEFAULT_ACTIVITY_LIMIT,
      });
      if (snapshot === null) return refuse('project_not_found');
      return { ok: true, snapshot: toToolSnapshot(snapshot) };
    },
  };
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function toToolSnapshot(snapshot: ProjectContinuitySnapshot): ProjectToolSnapshot {
  return {
    tasks: snapshot.tasks.map(({ task, link }) => ({
      taskId: link.taskId,
      subject: task?.subject ?? '',
      description: task?.description ?? '',
      status: task?.status ?? 'pending',
      acceptanceStatus: link.acceptanceStatus,
      workSessionId: link.workSessionId,
      updatedAt: link.updatedAt,
      recordAvailable: task !== null,
    })),
    activity: snapshot.activity.map(toToolActivity),
    nextCursor: snapshot.nextCursor,
  };
}

function toToolActivity(activity: ProjectActivity): ProjectToolActivity {
  return {
    cursor: activity.cursor,
    type: activity.type,
    taskId: activity.taskId,
    sessionId: activity.sessionId,
    runId: activity.runId,
    source: { type: activity.source.type, id: activity.source.id },
    payload: activity.payload,
    createdAt: activity.createdAt,
  };
}

function readInteger(value: unknown, min: number, max: number): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : 'invalid';
}
