/** Project authority and launch receipts behind the generic Session service. */
import { randomUUID } from 'node:crypto';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { ProjectTaskLifecycle, ProjectTaskStores } from './task-lifecycle.js';
import { createProjectTaskLifecycle } from './task-lifecycle.js';
import { PROJECT_TASK_DESCRIPTION_MAX_LENGTH, PROJECT_TASK_SUBJECT_MAX_LENGTH,
  PROJECT_WORK_SESSION_PROFILE_ID, isProjectCoordinatorProfile } from './identity.js';

export interface ProjectDispatchStores extends ProjectTaskStores {
  readonly projects: ProjectTaskStores['projects'] & Pick<CoreDataHostStores['projects'], 'getByCoordinatorSession' | 'listTaskLinks' | 'getTaskLinkByWorkSession'>;
  readonly runs?: Pick<CoreDataHostStores['runs'], 'getRun' | 'listRunsBySession'>;
}
export type ProjectTaskInput = { readonly subject: string; readonly description: string } |
  { readonly taskId: string; readonly expectedRevision: number };
export type ProjectDispatchPlan = { readonly kind: 'plain' } | { readonly kind: 'refused'; readonly reason: string } |
  { readonly kind: 'project'; readonly projectId: string; readonly task: ProjectTaskInput };
export type ProjectDispatchProjectPlan = Extract<ProjectDispatchPlan, { kind: 'project' }>;
export type ProjectTaskCreation = { readonly ok: true; readonly taskId: string; readonly attemptId: string } | { readonly ok: false; readonly reason: string };

export interface ProjectDispatchPort {
  planDispatch(input: { callerSessionId: string; callerProfileId: string | null | undefined; projectTask: unknown }): ProjectDispatchPlan;
  createTask(plan: ProjectDispatchProjectPlan, callerSessionId: string): ProjectTaskCreation;
  bindWorkSession(plan: ProjectDispatchProjectPlan, taskId: string, workSessionId: string): boolean;
  assertCanStart(taskId: string, callerSessionId: string, workSessionId: string): void;
  requiresProjectAuthority(workSessionId: string): boolean;
  recordStartResult(taskId: string, status: 'running' | 'failed' | 'unknown', reason?: string, runId?: string, attemptId?: string): void;
  prepareReply(callerProfileId: string | null | undefined, callerSessionId: string, workSessionId: string): { taskId: string; attemptId: string } | null;
  authorizesWorkSession(callerProfileId: string | null | undefined, callerSessionId: string, workSessionId: string): boolean;
  listWorkSessionIds(callerProfileId: string | null | undefined, callerSessionId: string): readonly string[];
  workSessionProfileId(parentProfileId: string | null): string | null;
}

export function createProjectDispatchPort(stores: ProjectDispatchStores): ProjectDispatchPort {
  const lifecycle: ProjectTaskLifecycle = createProjectTaskLifecycle(stores);
  function projectIdFor(callerSessionId: string): string | null {
    return stores.projects.getByCoordinatorSession(callerSessionId)?.project_id ?? null;
  }
  function linkedWorkSessionIds(callerSessionId: string): readonly string[] {
    const projectId = projectIdFor(callerSessionId);
    return projectId === null ? [] : stores.projects.listTaskLinks(projectId).map((link) => link.work_session_id)
      .filter((id): id is string => id !== null);
  }
  function requireNoLegacyRun(taskId: string): void {
    const link = stores.projects.getTaskLink(taskId);
    if (link?.work_session_id && stores.runs?.listRunsBySession(link.work_session_id).some((run) => run.status === 'running')) {
      throw new Error('task_execution_active');
    }
  }
  return {
    planDispatch({ callerSessionId, callerProfileId, projectTask }) {
      if (!isProjectCoordinatorProfile(callerProfileId)) return projectTask === undefined ? { kind: 'plain' } :
        { kind: 'refused', reason: 'project_task_requires_project_coordinator' };
      if (typeof projectTask !== 'object' || projectTask === null || Array.isArray(projectTask)) {
        return { kind: 'refused', reason: 'project_coordinator_requires_project_task' };
      }
      const record = projectTask as Record<string, unknown>;
      const projectId = projectIdFor(callerSessionId);
      if (!projectId) return { kind: 'refused', reason: 'project_coordinator_not_bound' };
      if ('taskId' in record) {
        if (Object.keys(record).some((key) => !['taskId', 'expectedRevision'].includes(key)) ||
          typeof record.taskId !== 'string' || !record.taskId.trim() || !Number.isSafeInteger(record.expectedRevision) ||
          (record.expectedRevision as number) < 0) return { kind: 'refused', reason: 'invalid_project_task' };
        const link = stores.projects.getTaskLink(record.taskId);
        if (link?.project_id !== projectId || !stores.tasks.get(record.taskId)) return { kind: 'refused', reason: 'project_task_not_found' };
        return { kind: 'project', projectId, task: { taskId: record.taskId, expectedRevision: record.expectedRevision as number } };
      }
      const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
      const description = typeof record.description === 'string' ? record.description.trim() : '';
      if (Object.keys(record).some((key) => key !== 'subject' && key !== 'description') || !subject ||
        subject.length > PROJECT_TASK_SUBJECT_MAX_LENGTH || !description || description.length > PROJECT_TASK_DESCRIPTION_MAX_LENGTH) {
        return { kind: 'refused', reason: 'invalid_project_task' };
      }
      return { kind: 'project', projectId, task: { subject, description } };
    },
    createTask(plan, callerSessionId) {
      try {
        const receipt = stores.projects.raw.transaction(() => {
          const id = 'taskId' in plan.task ? plan.task.taskId : lifecycle.create({ projectId: plan.projectId,
            coordinatorSessionId: callerSessionId, requestId: randomUUID(), ...plan.task });
          requireNoLegacyRun(id);
          const attempt = lifecycle.begin(plan.projectId, id, callerSessionId, 'taskId' in plan.task ? plan.task.expectedRevision : 0);
          return { taskId: id, attemptId: attempt.attempt_id };
        })();
        return { ok: true, ...receipt };
      } catch (error) {
        return { ok: false, reason: `project_task_create_failed:${error instanceof Error ? error.message : String(error)}` };
      }
    },
    bindWorkSession(_plan, taskId, workSessionId) {
      const attempt = stores.projects.listTaskAttempts(taskId)[0];
      if (!attempt) return false;
      lifecycle.bind(attempt.attempt_id, taskId, workSessionId, stores.runs?.listRunsBySession(workSessionId).map((run) => run.id));
      return true;
    },
    assertCanStart(taskId, callerSessionId, workSessionId) {
      const link = stores.projects.getTaskLink(taskId);
      if (!link || projectIdFor(callerSessionId) !== link.project_id || link.work_session_id !== workSessionId) {
        throw new Error('not_current_project_work');
      }
    },
    requiresProjectAuthority(workSessionId) {
      return stores.projects.getTaskLinkByWorkSession(workSessionId) !== null;
    },
    recordStartResult(taskId, status, reason, runId, attemptId) {
      const attempts = stores.projects.listTaskAttempts(taskId);
      const attempt = attemptId ? attempts.find((row) => row.attempt_id === attemptId) : attempts[0];
      if (!attempt) throw new Error('project_attempt_missing');
      const run = runId ? stores.runs?.getRun(runId) : undefined;
      lifecycle.finish(attempt.attempt_id, taskId, run?.terminal ? (run.status === 'completed' ? 'completed' : 'failed') : status,
        reason ?? null, runId ?? null);
    },
    prepareReply(callerProfileId, callerSessionId, workSessionId) {
      if (!isProjectCoordinatorProfile(callerProfileId)) return null;
      const projectId = projectIdFor(callerSessionId);
      const link = stores.projects.getTaskLinkByWorkSession(workSessionId);
      if (!projectId || !link || link.project_id !== projectId || link.work_session_id !== workSessionId) throw new Error('not_current_project_work');
      requireNoLegacyRun(link.task_id);
      const attempt = lifecycle.begin(projectId, link.task_id, callerSessionId, link.revision ?? 0);
      lifecycle.bind(attempt.attempt_id, link.task_id, workSessionId, stores.runs?.listRunsBySession(workSessionId).map((run) => run.id));
      return { taskId: link.task_id, attemptId: attempt.attempt_id };
    },
    authorizesWorkSession(callerProfileId, callerSessionId, workSessionId) {
      return isProjectCoordinatorProfile(callerProfileId) && linkedWorkSessionIds(callerSessionId).includes(workSessionId);
    },
    listWorkSessionIds(callerProfileId, callerSessionId) {
      return isProjectCoordinatorProfile(callerProfileId) ? linkedWorkSessionIds(callerSessionId) : [];
    },
    workSessionProfileId(parentProfileId) { return isProjectCoordinatorProfile(parentProfileId) ? PROJECT_WORK_SESSION_PROFILE_ID : parentProfileId; },
  };
}
