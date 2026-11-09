/**
 * dispatch.ts — the project domain's Session dispatch contract.
 *
 * Generic Session management creates and runs child Sessions; it does not
 * know that a Project Coordinator must attach a canonical Project Task to
 * every dispatch, that its children run as a work role, or that a
 * replacement Coordinator inherits work Sessions through the durable
 * project→task link. Those are project rules and live behind this port.
 *
 * Two phases keep the write ordering the Session service needs: plan first
 * (validate the role and the task without writing), then create the Task
 * only after the child workspace has been validated, so a refused dispatch
 * cannot leave an orphan Task behind.
 */

import { randomUUID } from 'node:crypto';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { ProjectStore } from '@duya/data/project-store';
import {
  PROJECT_TASK_DESCRIPTION_MAX_LENGTH,
  PROJECT_TASK_SUBJECT_MAX_LENGTH,
  PROJECT_WORK_SESSION_PROFILE_ID,
  isProjectCoordinatorProfile,
} from './identity.js';

export interface ProjectDispatchStores {
  readonly projects: Pick<
    ProjectStore,
    'getByCoordinatorSession' | 'listTaskLinks' | 'bindTask' | 'bindWorkSession'
  >;
  readonly tasks: Pick<CoreDataHostStores['tasks'], 'create' | 'update'>;
}

export interface ProjectTaskInput {
  readonly subject: string;
  readonly description: string;
}

export type ProjectDispatchPlan =
  | { readonly kind: 'plain' }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly task: ProjectTaskInput;
    };

export type ProjectDispatchProjectPlan = Extract<ProjectDispatchPlan, { kind: 'project' }>;

export type ProjectTaskCreation =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly reason: string };

export interface ProjectDispatchPort {
  /**
   * Decide what a spawn means for this caller. Validation only — the Task is
   * created by `createTask` after the child workspace has been accepted.
   */
  planDispatch(input: {
    readonly callerSessionId: string;
    readonly callerProfileId: string | null | undefined;
    readonly projectTask: unknown;
  }): ProjectDispatchPlan;

  /** Persist the canonical Project Task and bind it to the Coordinator. */
  createTask(plan: ProjectDispatchProjectPlan, callerSessionId: string): ProjectTaskCreation;

  /** Bind the work Session that will execute the Task. */
  bindWorkSession(
    plan: ProjectDispatchProjectPlan,
    taskId: string,
    workSessionId: string,
  ): boolean;

  setTaskStatus(taskId: string, status: 'pending' | 'in_progress'): void;

  /**
   * Authorize management of a work Session through project and task
   * belonging. Work Sessions outlive the Coordinator that spawned them, so
   * parentSessionId alone would deny every replacement Coordinator.
   */
  authorizesWorkSession(
    callerProfileId: string | null | undefined,
    callerSessionId: string,
    workSessionId: string,
  ): boolean;

  /** Work Session ids linked to the project the caller currently coordinates. */
  listWorkSessionIds(
    callerProfileId: string | null | undefined,
    callerSessionId: string,
  ): readonly string[];

  /** The role a dispatched work Session runs as. */
  workSessionProfileId(parentProfileId: string | null): string | null;
}

export function createProjectDispatchPort(
  stores: ProjectDispatchStores,
): ProjectDispatchPort {
  function projectIdFor(callerSessionId: string): string | null {
    return stores.projects.getByCoordinatorSession(callerSessionId)?.project_id ?? null;
  }

  function linkedWorkSessionIds(callerSessionId: string): readonly string[] {
    const projectId = projectIdFor(callerSessionId);
    if (projectId === null) return [];
    return stores.projects
      .listTaskLinks(projectId)
      .map((link) => link.work_session_id)
      .filter((id): id is string => id !== null);
  }

  return {
    planDispatch({ callerSessionId, callerProfileId, projectTask }) {
      if (!isProjectCoordinatorProfile(callerProfileId)) {
        return projectTask === undefined
          ? { kind: 'plain' }
          : { kind: 'refused', reason: 'project_task_requires_project_coordinator' };
      }
      if (typeof projectTask !== 'object' || projectTask === null || Array.isArray(projectTask)) {
        return { kind: 'refused', reason: 'project_coordinator_requires_project_task' };
      }
      const record = projectTask as Record<string, unknown>;
      const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
      const description = typeof record.description === 'string' ? record.description.trim() : '';
      if (
        Object.keys(record).some((key) => key !== 'subject' && key !== 'description') ||
        subject === '' ||
        subject.length > PROJECT_TASK_SUBJECT_MAX_LENGTH ||
        description === '' ||
        description.length > PROJECT_TASK_DESCRIPTION_MAX_LENGTH
      ) {
        return { kind: 'refused', reason: 'invalid_project_task' };
      }
      const projectId = projectIdFor(callerSessionId);
      if (projectId === null) {
        return { kind: 'refused', reason: 'project_coordinator_not_bound' };
      }
      return { kind: 'project', projectId, task: { subject, description } };
    },

    createTask(plan, callerSessionId) {
      const taskId = randomUUID();
      try {
        stores.tasks.create({
          id: taskId,
          sessionId: callerSessionId,
          subject: plan.task.subject,
          description: plan.task.description,
          status: 'pending',
        });
        stores.projects.bindTask(plan.projectId, taskId, callerSessionId);
      } catch (error) {
        return {
          ok: false,
          reason: `project_task_create_failed:${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { ok: true, taskId };
    },

    bindWorkSession(plan, taskId, workSessionId) {
      return stores.projects.bindWorkSession(plan.projectId, taskId, workSessionId) !== null;
    },

    setTaskStatus(taskId, status) {
      stores.tasks.update(taskId, { status });
    },

    authorizesWorkSession(callerProfileId, callerSessionId, workSessionId) {
      return (
        isProjectCoordinatorProfile(callerProfileId) &&
        linkedWorkSessionIds(callerSessionId).includes(workSessionId)
      );
    },

    listWorkSessionIds(callerProfileId, callerSessionId) {
      if (!isProjectCoordinatorProfile(callerProfileId)) return [];
      return linkedWorkSessionIds(callerSessionId);
    },

    workSessionProfileId(parentProfileId) {
      return isProjectCoordinatorProfile(parentProfileId)
        ? PROJECT_WORK_SESSION_PROFILE_ID
        : parentProfileId;
    },
  };
}
