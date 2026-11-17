/**
 * tool-service.ts — the Host half of the project tool.
 *
 * The capability asks in project terms; this service turns those requests into
 * the existing `HostProjectApiV1` calls. Two rules are enforced here rather
 * than in the worker:
 *
 *   1. The project is resolved from the caller's durable Coordinator binding,
 *      never from a worker-supplied project id.
 *   2. Writes carry the calling Session as their provenance. Statuses that
 *      mean "the user decided" (accepted decision, active memory) are refused,
 *      because a tool call is not a user message.
 */

import type {
  HostProjectApiV1,
  ProjectActivity,
  ProjectContinuitySnapshot,
  ProjectContinuityState,
  ProjectDecision,
  ProjectMemory,
} from '@duya/agent-protocol/projects';
import type { ProjectStore } from '@duya/data/project-store';
import type {
  ProjectToolAction,
  ProjectToolActivity,
  ProjectToolContext,
  ProjectToolDecision,
  ProjectToolMemory,
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolSnapshot,
  ProjectToolState,
} from '@duya/capabilities/project';

import type { ProjectSessionPromptContext } from './context.js';

const PROJECT_TOOL_ACTIONS: ReadonlySet<string> = new Set([
  'get',
  'context',
  'update_state',
  'record_decision',
  'record_memory',
  'create_task',
  'update_task',
]);

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 100;
const DEFAULT_CONTEXT_CHARACTERS = 8_000;
const MAX_CONTEXT_CHARACTERS = 16_000;

export interface ProjectToolServiceStores {
  readonly projects: Pick<ProjectStore, 'getByCoordinatorSession' | 'getTaskLinkByWorkSession'>;
}

export interface ProjectToolServiceOptions {
  readonly stores: ProjectToolServiceStores;
  readonly projectApi: Pick<
    HostProjectApiV1,
    | 'getProjectContinuity'
    | 'getProjectContext'
    | 'updateProjectState'
    | 'updateProjectDecision'
    | 'updateProjectMemory'
    | 'createProjectTask'
    | 'updateProjectTask'
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

      switch (action as ProjectToolAction) {
        case 'create_task':
        case 'update_task': {
          const keys = action === 'create_task' ? ['requestId', 'subject', 'description'] : ['taskId', 'expectedRevision', 'subject', 'description', 'status'];
          if (Object.keys(payload).some((key) => !keys.includes(key))) return refuse('invalid_task_payload');
          try {
            if (action === 'create_task') {
              if (typeof payload.requestId !== 'string' || typeof payload.subject !== 'string' || typeof payload.description !== 'string') return refuse('invalid_task_payload');
              const row = await projectApi.createProjectTask({ projectId, coordinatorSessionId: callerSessionId,
                requestId: payload.requestId, subject: payload.subject, description: payload.description });
              return { ok: true, task: toToolTask(row) };
            }
            const expectedRevision = readInteger(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
            if (expectedRevision === undefined || expectedRevision === 'invalid' || typeof payload.taskId !== 'string' ||
              (payload.status !== undefined && payload.status !== 'pending') ||
              (payload.subject !== undefined && typeof payload.subject !== 'string') ||
              (payload.description !== undefined && typeof payload.description !== 'string')) return refuse('invalid_task_payload');
            const row = await projectApi.updateProjectTask({ projectId, coordinatorSessionId: callerSessionId,
              taskId: payload.taskId, expectedRevision,
              ...(typeof payload.subject === 'string' ? { subject: payload.subject } : {}),
              ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
              ...(payload.status === 'pending' ? { status: 'pending' as const } : {}) });
            return { ok: true, task: toToolTask(row) };
          } catch (error) { return refuse(messageOf(error)); }
        }
        case 'get': {
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
        }

        case 'context': {
          const taskId = readString(payload.taskId);
          if (taskId !== undefined && taskId.trim() === '') return refuse('invalid_taskId');
          const maxCharacters = readInteger(payload.maxCharacters, 200, MAX_CONTEXT_CHARACTERS);
          if (maxCharacters === 'invalid') return refuse('invalid_maxCharacters');
          const context = await projectApi.getProjectContext(
            projectId,
            taskId,
            maxCharacters ?? DEFAULT_CONTEXT_CHARACTERS,
          );
          if (context === null) return refuse('project_not_found');
          return {
            ok: true,
            context: toToolContext(context),
          };
        }

        case 'update_state': {
          const expectedRevision = readInteger(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
          if (expectedRevision === undefined || expectedRevision === 'invalid') {
            return refuse('invalid_expectedRevision');
          }
          const currentState = readString(payload.currentState)?.trim() ?? '';
          if (currentState === '') return refuse('invalid_currentState');
          const nextStep = readString(payload.nextStep)?.trim() ?? '';
          const state = await projectApi.updateProjectState({
            projectId,
            expectedRevision,
            currentState,
            nextStep,
            source: sessionSource(callerSessionId),
          });
          if (state === null) return refuse('revision_conflict');
          return { ok: true, state: toToolState(state) };
        }

        case 'record_decision': {
          const expectedRevision = readInteger(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
          if (expectedRevision === undefined || expectedRevision === 'invalid') {
            return refuse('invalid_expectedRevision');
          }
          const key = readString(payload.key)?.trim() ?? '';
          const content = readString(payload.content)?.trim() ?? '';
          if (key === '') return refuse('invalid_key');
          if (content === '') return refuse('invalid_content');
          const status = readString(payload.status) ?? 'proposed';
          if (status === 'accepted') return refuse('user_action_required');
          if (status !== 'proposed' && status !== 'superseded') return refuse('invalid_status');
          try {
            const decision = await projectApi.updateProjectDecision({
              projectId,
              key,
              content,
              status,
              expectedRevision,
              source: sessionSource(callerSessionId),
            });
            if (decision === null) return refuse('revision_conflict');
            return { ok: true, decision: toToolDecision(decision) };
          } catch (error) {
            return refuse(messageOf(error));
          }
        }

        case 'record_memory': {
          const expectedRevision = readInteger(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
          if (expectedRevision === undefined || expectedRevision === 'invalid') {
            return refuse('invalid_expectedRevision');
          }
          const key = readString(payload.key)?.trim() ?? '';
          const content = readString(payload.content)?.trim() ?? '';
          if (key === '') return refuse('invalid_key');
          if (content === '') return refuse('invalid_content');
          const status = readString(payload.status) ?? 'candidate';
          if (status === 'active') return refuse('user_action_required');
          if (status !== 'candidate' && status !== 'superseded' && status !== 'retired') {
            return refuse('invalid_status');
          }
          try {
            const memory = await projectApi.updateProjectMemory({
              projectId,
              key,
              content,
              status,
              expectedRevision,
              source: sessionSource(callerSessionId),
            });
            if (memory === null) return refuse('revision_conflict');
            return { ok: true, memory: toToolMemory(memory) };
          } catch (error) {
            return refuse(messageOf(error));
          }
        }
      }
    },
  };
}

function sessionSource(callerSessionId: string): { type: 'session'; id: string } {
  return { type: 'session', id: callerSessionId };
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function toToolSnapshot(snapshot: ProjectContinuitySnapshot): ProjectToolSnapshot {
  return {
    project: {
      projectId: snapshot.project.project_id,
      name: snapshot.project.name,
      coordinatorSessionId: snapshot.project.coordinator_session_id,
    },
    state: snapshot.state === null ? null : toToolState(snapshot.state),
    tasks: snapshot.tasks.map(toToolTask),
    decisions: snapshot.decisions.map(toToolDecision),
    memories: snapshot.memories.map(toToolMemory),
    activity: snapshot.activity.map(toToolActivity),
    nextCursor: snapshot.nextCursor,
  };
}

function toToolTask({ task, link, attempts }: import('@duya/agent-protocol/projects').ProjectTaskSnapshot) {
  return { taskId: link.taskId, subject: task?.subject ?? '', description: task?.description ?? '',
    status: task?.status ?? 'unknown', acceptanceStatus: link.acceptanceStatus, workSessionId: link.workSessionId,
    updatedAt: link.updatedAt, recordAvailable: task !== null, revision: link.revision ?? 0, attempts: attempts ?? [] };
}

function toToolState(state: ProjectContinuityState): ProjectToolState {
  return {
    revision: state.revision,
    currentState: state.currentState,
    nextStep: state.nextStep,
    source: { type: state.source.type, id: state.source.id },
    updatedAt: state.updatedAt,
  };
}

function toToolDecision(decision: ProjectDecision): ProjectToolDecision {
  return {
    key: decision.key,
    content: decision.content,
    status: decision.status,
    revision: decision.revision,
    source: { type: decision.source.type, id: decision.source.id },
    updatedAt: decision.updatedAt,
  };
}

function toToolMemory(memory: ProjectMemory): ProjectToolMemory {
  return {
    key: memory.key,
    content: memory.content,
    status: memory.status,
    revision: memory.revision,
    source: { type: memory.source.type, id: memory.source.id },
    updatedAt: memory.updatedAt,
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

function toToolContext(context: {
  readonly text: string;
  readonly sourceRefs: readonly { readonly type: string; readonly id: string }[];
}): ProjectToolContext {
  return {
    text: context.text,
    sourceRefs: context.sourceRefs.map((source) => ({ type: source.type, id: source.id })),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readInteger(value: unknown, min: number, max: number): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : 'invalid';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
