/** Canonical Task mutations and durable launch receipts. No model-supplied principal. */
import { createHash, randomUUID } from 'node:crypto';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { ProjectStore, ProjectTaskAttemptRow, ProjectTaskLinkRow } from '@duya/data/project-store';
import type { ProjectTaskCreateInput, ProjectTaskReviewInput, ProjectTaskUpdateInput } from '@duya/agent-protocol/projects';
import { PROJECT_TASK_DESCRIPTION_MAX_LENGTH, PROJECT_TASK_SUBJECT_MAX_LENGTH } from './identity.js';

export type ProjectTaskStores = {
  projects: Pick<ProjectStore, 'raw' | 'get' | 'getTaskLink' | 'bindTask' | 'bindWorkSession' | 'bumpTaskRevision' |
    'setTaskAcceptance' | 'appendActivity' | 'listTaskAttempts' | 'listOpenTaskAttempts' |
    'insertTaskAttempt' | 'updateTaskAttempt' | 'getTaskReview' | 'insertTaskReview'>;
  tasks: Pick<CoreDataHostStores['tasks'], 'get' | 'create' | 'update'>;
};

const OPEN = new Set(['starting', 'running', 'unknown']);
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid_expectedRevision');
}
function text(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`invalid_${name}`);
  return value.trim();
}
function requestKey(projectId: string, requestId: string, kind: string): string {
  text(requestId, 160, 'requestId');
  return createHash('sha256').update(JSON.stringify([kind, projectId, requestId])).digest('hex');
}

export function createProjectTaskLifecycle(stores: ProjectTaskStores) {
  const { projects, tasks } = stores;
  function current(projectId: string, coordinatorSessionId: string): void {
    if (projects.get(projectId)?.coordinator_session_id !== coordinatorSessionId) throw new Error('not_project_coordinator');
  }
  function linkFor(projectId: string, taskId: string): ProjectTaskLinkRow {
    const link = projects.getTaskLink(taskId);
    if (!link || link.project_id !== projectId || !tasks.get(taskId)) throw new Error('project_task_not_found');
    return link;
  }
  function bump(link: ProjectTaskLinkRow, expected: number): void {
    revision(expected);
    if (!projects.bumpTaskRevision(link.task_id, expected)) throw new Error('revision_conflict');
  }
  function active(taskId: string): boolean {
    return projects.listTaskAttempts(taskId).some((attempt) => OPEN.has(attempt.status));
  }
  function activity(link: ProjectTaskLinkRow, type: string, sourceType: string, sourceId: string,
    payload: Record<string, unknown> = {}, attempt?: ProjectTaskAttemptRow): void {
    projects.appendActivity({ project_id: link.project_id, task_id: link.task_id, event_type: type,
      session_id: attempt?.work_session_id ?? null, run_id: attempt?.run_id ?? null,
      source_type: sourceType, source_id: sourceId, payload: JSON.stringify(payload) });
  }

  function create(input: ProjectTaskCreateInput): string {
    return projects.raw.transaction(() => {
      current(input.projectId, input.coordinatorSessionId);
      const subject = text(input.subject, PROJECT_TASK_SUBJECT_MAX_LENGTH, 'subject');
      const description = text(input.description, PROJECT_TASK_DESCRIPTION_MAX_LENGTH, 'description');
      const id = requestKey(input.projectId, input.requestId, 'task');
      const existing = tasks.get(id);
      if (existing) {
        linkFor(input.projectId, id);
        if (existing.metadata.projectCreate !== JSON.stringify([subject, description])) throw new Error('request_id_conflict');
        return id;
      }
      tasks.create({ id, sessionId: input.coordinatorSessionId, subject, description, status: 'pending',
        metadata: { projectCreate: JSON.stringify([subject, description]) } });
      projects.bindTask(input.projectId, id, input.coordinatorSessionId);
      return id;
    })();
  }

  function update(input: ProjectTaskUpdateInput): void {
    projects.raw.transaction(() => {
      current(input.projectId, input.coordinatorSessionId);
      const link = linkFor(input.projectId, input.taskId);
      if (active(input.taskId)) throw new Error('task_execution_active');
      if (link.acceptance_status === 'accepted') throw new Error('user_action_required');
      if (input.status !== undefined && input.status !== 'pending') throw new Error('invalid_task_status');
      const subject = input.subject === undefined ? undefined : text(input.subject, PROJECT_TASK_SUBJECT_MAX_LENGTH, 'subject');
      const description = input.description === undefined ? undefined : text(input.description, PROJECT_TASK_DESCRIPTION_MAX_LENGTH, 'description');
      if (subject === undefined && description === undefined && input.status === undefined) throw new Error('empty_task_patch');
      bump(link, input.expectedRevision);
      // Editing a completed brief invalidates its previous completion evidence.
      tasks.update(input.taskId, { ...(subject === undefined ? {} : { subject }),
        ...(description === undefined ? {} : { description }), status: 'pending' });
      if (link.acceptance_status !== 'pending') projects.setTaskAcceptance(input.projectId, input.taskId, 'pending', 'session', input.coordinatorSessionId);
      activity(link, 'task.updated', 'session', input.coordinatorSessionId, { revision: input.expectedRevision + 1 });
    })();
  }

  function review(input: ProjectTaskReviewInput): ProjectTaskLinkRow {
    return projects.raw.transaction(() => {
      current(input.projectId, input.sessionId);
      const link = linkFor(input.projectId, input.taskId);
      const note = text(input.note, 4000, 'note');
      revision(input.expectedRevision);
      if (input.status !== 'accepted' && input.status !== 'rejected') throw new Error('invalid_acceptance_status');
      const reviewId = requestKey(input.projectId, input.requestId, 'review');
      const existing = projects.getTaskReview(reviewId);
      if (existing) {
        if (existing.task_id !== input.taskId || existing.session_id !== input.sessionId || existing.status !== input.status ||
          existing.note !== note || existing.expected_revision !== input.expectedRevision) throw new Error('request_id_conflict');
        return link;
      }
      if (active(input.taskId)) throw new Error('task_execution_active');
      if (input.status === 'accepted' && tasks.get(input.taskId)?.status !== 'completed') throw new Error('task_not_completed');
      bump(link, input.expectedRevision);
      // This immutable receipt is a control-plane user action, never a fabricated user message.
      projects.insertTaskReview({ review_id: reviewId, project_id: input.projectId, task_id: input.taskId,
        session_id: input.sessionId, expected_revision: input.expectedRevision, status: input.status, note, created_at: Date.now() });
      projects.setTaskAcceptance(input.projectId, input.taskId, input.status, 'user_action', reviewId);
      activity(link, 'task.reviewed', 'user_action', reviewId, { status: input.status, note, expectedRevision: input.expectedRevision });
      if (input.status === 'rejected') tasks.update(input.taskId, { status: 'pending' });
      return projects.getTaskLink(input.taskId)!;
    })();
  }

  function begin(projectId: string, taskId: string, coordinatorId: string, expectedRevision: number): ProjectTaskAttemptRow {
    return projects.raw.transaction(() => {
      current(projectId, coordinatorId);
      const link = linkFor(projectId, taskId);
      if (active(taskId)) throw new Error('task_execution_active');
      if (link.acceptance_status === 'accepted') throw new Error('task_already_accepted');
      if (tasks.get(taskId)?.status === 'completed' && link.acceptance_status === 'pending') throw new Error('task_awaiting_acceptance');
      bump(link, expectedRevision);
      if (link.acceptance_status === 'rejected') projects.setTaskAcceptance(projectId, taskId, 'pending', 'session', coordinatorId);
      const now = Date.now();
      const attempt: ProjectTaskAttemptRow = { attempt_id: randomUUID(), project_id: projectId, task_id: taskId,
        coordinator_session_id: coordinatorId, work_session_id: null, run_id: null, prior_run_ids: '[]', status: 'starting', reason: null,
        created_at: now, updated_at: now };
      projects.insertTaskAttempt(attempt);
      tasks.update(taskId, { status: 'pending' });
      activity(link, 'task.dispatch_starting', 'session', coordinatorId, { attemptId: attempt.attempt_id }, attempt);
      return attempt;
    })();
  }

  function bind(attemptId: string, taskId: string, workSessionId: string, priorRunIds: readonly string[] = []): void {
    projects.raw.transaction(() => {
      const attempt = projects.listTaskAttempts(taskId).find((row) => row.attempt_id === attemptId);
      if (!attempt || attempt.status !== 'starting') throw new Error('attempt_not_starting');
      current(attempt.project_id, attempt.coordinator_session_id);
      if (!projects.bindWorkSession(attempt.project_id, taskId, workSessionId)) throw new Error('project_task_binding_failed');
      projects.updateTaskAttempt(attemptId, { ...attempt, work_session_id: workSessionId, prior_run_ids: JSON.stringify(priorRunIds) });
    })();
  }

  function finish(attemptId: string, taskId: string, status: ProjectTaskAttemptRow['status'], reason: string | null, runId: string | null = null): void {
    projects.raw.transaction(() => {
      const attempt = projects.listTaskAttempts(taskId).find((row) => row.attempt_id === attemptId);
      if (!attempt || !OPEN.has(attempt.status)) return;
      const link = linkFor(attempt.project_id, taskId);
      const updated = { ...attempt, status, reason, run_id: runId ?? attempt.run_id };
      projects.updateTaskAttempt(attemptId, updated);
      bump(link, link.revision ?? 0);
      tasks.update(taskId, { status: status === 'completed' ? 'completed' : status === 'running' ? 'in_progress' : 'pending' });
      activity(link, `task.dispatch_${status}`, 'session', attempt.coordinator_session_id,
        { attemptId, reason, revision: (link.revision ?? 0) + 1 }, updated);
    })();
  }

  function priorRuns(attempt: ProjectTaskAttemptRow): Set<string> {
    const ids: unknown = JSON.parse(attempt.prior_run_ids);
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) throw new Error('invalid_attempt_run_baseline');
    return new Set(ids);
  }

  function settle(runId: string, sessionId: string, completed: boolean): void {
    const attempt = projects.listOpenTaskAttempts().find((row) => row.work_session_id === sessionId && (row.run_id === null || row.run_id === runId) && !priorRuns(row).has(runId));
    if (attempt) finish(attempt.attempt_id, attempt.task_id, completed ? 'completed' : 'failed', completed ? null : 'run_did_not_complete', runId);
  }

  function recover(listRuns: (sessionId: string) => readonly { id: string; status: string; terminal: string | null; created_at: number }[]): void {
    for (const attempt of projects.listOpenTaskAttempts()) {
      const runs = attempt.work_session_id ? listRuns(attempt.work_session_id) : [];
      const prior = priorRuns(attempt);
      const candidates = runs.filter((run) => !prior.has(run.id) && (attempt.run_id ? run.id === attempt.run_id : run.created_at >= attempt.created_at));
      if (candidates.length > 1) {
        if (attempt.status !== 'unknown') finish(attempt.attempt_id, attempt.task_id, 'unknown', 'multiple_runs_require_reconciliation');
        continue;
      }
      const run = candidates[0];
      if (!run) {
        finish(attempt.attempt_id, attempt.task_id, 'failed', 'host_restarted_before_launch_receipt');
      } else if (run.terminal !== null) {
        finish(attempt.attempt_id, attempt.task_id, run.status === 'completed' ? 'completed' : 'failed',
          run.status === 'completed' ? null : 'recovered_run_did_not_complete', run.id);
      } else if (run.status === 'running' && (attempt.status !== 'running' || attempt.run_id !== run.id)) {
        finish(attempt.attempt_id, attempt.task_id, 'running', null, run.id);
      }
    }
  }

  return { create, update, review, begin, bind, finish, settle, recover };
}

export type ProjectTaskLifecycle = ReturnType<typeof createProjectTaskLifecycle>;
