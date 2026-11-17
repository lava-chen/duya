import { describe, expect, it, vi } from 'vitest';
import { projectTaskFixture } from './project-task-fixture.js';
import { createProjectDispatchPort } from '../src/project/dispatch.js';
import { createProjectToolService } from '../src/project/tool-service.js';
import { createHostTaskApi } from '../src/task-api.js';

function createTask(f = projectTaskFixture()) {
  const input = { projectId: f.projectId, coordinatorSessionId: f.coordinatorId,
    requestId: 'create-1', subject: 'Ship billing', description: 'Implement billing with tests' };
  const taskId = f.lifecycle.create(input);
  return { ...f, taskId, input };
}
function launch(f: ReturnType<typeof createTask>, sessionId = 'work-1') {
  const attempt = f.lifecycle.begin(f.projectId, f.taskId, f.coordinatorId, f.projects.getTaskLink(f.taskId)!.revision!);
  f.lifecycle.bind(attempt.attempt_id, f.taskId, sessionId);
  return attempt;
}

describe('canonical Project Task lifecycle', () => {
  it('creates independently and deduplicates a lost response without losing updates', () => {
    const f = createTask();
    f.lifecycle.update({ ...f.input, taskId: f.taskId, expectedRevision: 0, subject: 'Updated billing' });
    expect(f.lifecycle.create(f.input)).toBe(f.taskId);
    expect(f.tasks.getBySession(f.coordinatorId)).toHaveLength(1);
    expect(f.tasks.get(f.taskId)?.subject).toBe('Updated billing');
    expect(() => f.lifecycle.create({ ...f.input, subject: 'Different task' })).toThrow('request_id_conflict');
  });

  it('rolls canonical creation back if its project binding fails', () => {
    const f = projectTaskFixture();
    vi.spyOn(f.projects, 'bindTask').mockImplementation(() => { throw new Error('binding unavailable'); });
    expect(() => f.lifecycle.create({ projectId: f.projectId, coordinatorSessionId: f.coordinatorId,
      requestId: 'r1', subject: 'Title', description: 'Brief' })).toThrow('binding unavailable');
    expect(f.tasks.getBySession(f.coordinatorId)).toEqual([]);
  });

  it('checks revisions, project membership, current Coordinator and immutable accepted work', () => {
    const f = createTask();
    const patch = { projectId: f.projectId, coordinatorSessionId: f.coordinatorId, taskId: f.taskId, expectedRevision: 0, subject: 'New brief' };
    expect(() => f.lifecycle.update({ ...patch, projectId: 'other-project' })).toThrow('not_project_coordinator');
    f.lifecycle.update(patch);
    expect(() => f.lifecycle.update(patch)).toThrow('revision_conflict');
    f.projects.bindCoordinatorSession(f.projectId, 'replacement');
    expect(() => f.lifecycle.update({ ...patch, expectedRevision: 1 })).toThrow('not_project_coordinator');
    f.lifecycle.update({ ...patch, coordinatorSessionId: 'replacement', expectedRevision: 1 });
    expect(f.projects.getTaskLink(f.taskId)?.revision).toBe(2);
    expect(f.tasks.get(f.taskId)?.sessionId).toBe(f.coordinatorId);
  });

  it('refuses cross-project existing tasks and mixed dispatch payloads', () => {
    const f = createTask();
    const port = createProjectDispatchPort(f.stores);
    for (const projectTask of [{ taskId: f.taskId, expectedRevision: 0, subject: 'evil' },
      { taskId: f.taskId, expectedRevision: -1 }, { taskId: 'foreign-task', expectedRevision: 0 }]) {
      expect(port.planDispatch({ callerSessionId: f.coordinatorId, callerProfileId: 'project-coordinator', projectTask }).kind).toBe('refused');
    }
    f.projects.insert({ project_id: 'foreign', canonical_root: '/foreign' });
    f.projects.bindCoordinatorSession('foreign', 'other');
    f.tasks.create({ id: 'foreign-task', sessionId: 'other', subject: 'Foreign', description: 'Foreign' });
    f.projects.bindTask('foreign', 'foreign-task', 'other');
    expect(port.planDispatch({ callerSessionId: f.coordinatorId, callerProfileId: 'project-coordinator',
      projectTask: { taskId: 'foreign-task', expectedRevision: 0 } })).toMatchObject({ reason: 'project_task_not_found' });
  });

  it('reserves one launch atomically before any asynchronous Session work', () => {
    const f = createTask();
    const attempt = launch(f);
    expect(f.tasks.get(f.taskId)?.status).toBe('pending');
    expect(() => launch(f, 'work-2')).toThrow('task_execution_active');
    expect(() => f.lifecycle.update({ ...f.input, taskId: f.taskId, expectedRevision: 1, subject: 'Changed' })).toThrow('task_execution_active');
    f.lifecycle.finish(attempt.attempt_id, f.taskId, 'running', null, 'run-1');
    expect(f.tasks.get(f.taskId)?.status).toBe('in_progress');
  });

  it('preserves launch history and Task identity across failure, retry and Coordinator replacement', () => {
    const f = createTask();
    const attempt = launch(f);
    f.lifecycle.finish(attempt.attempt_id, f.taskId, 'failed', 'provider unavailable');
    expect(f.projects.listTaskAttempts(f.taskId)[0]?.reason).toBe('provider unavailable');
    f.projects.bindCoordinatorSession(f.projectId, 'replacement');
    const next = f.lifecycle.begin(f.projectId, f.taskId, 'replacement', f.projects.getTaskLink(f.taskId)!.revision!);
    f.lifecycle.bind(next.attempt_id, f.taskId, 'work-2');
    expect(f.projects.listTaskAttempts(f.taskId)).toHaveLength(2);
    expect(f.projects.getTaskLinkByWorkSession('work-1')?.task_id).toBe(f.taskId);
    expect(f.projects.getTaskLink(f.taskId)?.work_session_id).toBe('work-2');
    expect(f.tasks.getBySession(f.coordinatorId)).toHaveLength(1);
    f.lifecycle.settle('late-old-run', 'work-1', true);
    createProjectDispatchPort(f.stores).recordStartResult(f.taskId, 'failed', 'late startup response', undefined, attempt.attempt_id);
    expect(f.tasks.get(f.taskId)?.status).toBe('pending');
    expect(f.projects.listTaskAttempts(f.taskId)[0]?.status).toBe('starting');
  });

  it('records successful execution separately from explicit, revision-checked user acceptance', async () => {
    const f = createTask();
    const attempt = launch(f);
    f.lifecycle.finish(attempt.attempt_id, f.taskId, 'running', null, 'run-1');
    f.lifecycle.settle('run-1', 'work-1', true);
    expect(f.tasks.get(f.taskId)?.status).toBe('completed');
    expect(f.projects.getTaskLink(f.taskId)?.acceptance_status).toBe('pending');
    const before = f.projects.getTaskLink(f.taskId)!.revision!;
    const review = { projectId: f.projectId, taskId: f.taskId, sessionId: f.coordinatorId,
      expectedRevision: before, requestId: 'review-1', status: 'accepted' as const, note: 'Tests and requested behavior verified' };
    expect(() => f.lifecycle.review({ ...review, expectedRevision: before - 1 })).toThrow('revision_conflict');
    expect(f.lifecycle.review(review).acceptance_status).toBe('accepted');
    expect(f.lifecycle.review(review).revision).toBe(before + 1);
    const snapshot = await f.api.getProjectContinuity(f.projectId);
    const event = snapshot!.activity.find((row) => row.type === 'task.accepted')!;
    expect(event.source.type).toBe('user_action');
    expect(f.projects.getTaskReview(event.source.id)).toMatchObject({ note: review.note, session_id: f.coordinatorId });
    expect(snapshot!.activity.filter((row) => row.type === 'task.accepted')).toHaveLength(1);
    expect(() => f.lifecycle.begin(f.projectId, f.taskId, f.coordinatorId, before + 1)).toThrow('task_already_accepted');
    expect(() => f.lifecycle.update({ ...f.input, taskId: f.taskId, expectedRevision: before + 1, status: 'pending' })).toThrow('user_action_required');
  });

  it('rejects unfinished or active work, rejects request-key reuse, and supports rejection then same-Task retry', () => {
    const f = createTask();
    const review = { projectId: f.projectId, taskId: f.taskId, sessionId: f.coordinatorId,
      expectedRevision: 0, requestId: 'review-1', status: 'accepted' as const, note: 'Reviewed' };
    expect(() => f.lifecycle.review(review)).toThrow('task_not_completed');
    const attempt = launch(f);
    expect(() => f.lifecycle.review({ ...review, expectedRevision: 1 })).toThrow('task_execution_active');
    f.lifecycle.finish(attempt.attempt_id, f.taskId, 'completed', null, 'run-1');
    const rejection = { ...review, status: 'rejected' as const, note: 'Missing edge case', expectedRevision: f.projects.getTaskLink(f.taskId)!.revision! };
    f.lifecycle.review(rejection);
    expect(f.tasks.get(f.taskId)?.status).toBe('pending');
    expect(() => f.lifecycle.review({ ...rejection, note: 'Changed' })).toThrow('request_id_conflict');
    launch(f, 'retry-work');
    expect(f.projects.getTaskLink(f.taskId)?.acceptance_status).toBe('pending');
  });

  it('recovers pre-Session failure and an uncertain but live launch without starting duplicate work', () => {
    const f = createTask();
    const first = f.lifecycle.begin(f.projectId, f.taskId, f.coordinatorId, 0);
    f.lifecycle.recover(() => []);
    expect(f.projects.listTaskAttempts(f.taskId)[0]).toMatchObject({ attempt_id: first.attempt_id, status: 'failed', reason: 'host_restarted_before_launch_receipt' });
    const next = launch(f);
    f.lifecycle.finish(next.attempt_id, f.taskId, 'unknown', 'transport disconnected');
    const run = { id: 'run-recovered', status: 'running', terminal: null, created_at: next.created_at };
    f.lifecycle.recover(() => [run]);
    expect(f.projects.listTaskAttempts(f.taskId)[0]).toMatchObject({ status: 'running', run_id: run.id });
    expect(() => launch(f)).toThrow('task_execution_active');
    const rev = f.projects.getTaskLink(f.taskId)!.revision;
    f.lifecycle.recover(() => [run]);
    expect(f.projects.getTaskLink(f.taskId)!.revision).toBe(rev);
    f.lifecycle.recover(() => [{ ...run, status: 'completed', terminal: 'completed' }]);
    expect(f.tasks.get(f.taskId)?.status).toBe('completed');
    expect(f.projects.getTaskLink(f.taskId)?.acceptance_status).toBe('pending');
  });

  it('does not attribute a same-millisecond prior Run to a new reply attempt', () => {
    const f = createTask();
    const attempt = f.lifecycle.begin(f.projectId, f.taskId, f.coordinatorId, 0);
    f.lifecycle.bind(attempt.attempt_id, f.taskId, 'work-1', ['prior-run']);
    f.lifecycle.settle('prior-run', 'work-1', true);
    expect(f.projects.listTaskAttempts(f.taskId)[0]?.status).toBe('starting');
    f.lifecycle.recover(() => [
      { id: 'prior-run', created_at: attempt.created_at, status: 'completed', terminal: 'completed' },
      { id: 'new-run', created_at: attempt.created_at, status: 'running', terminal: null },
    ]);
    expect(f.projects.listTaskAttempts(f.taskId)[0]).toMatchObject({ status: 'running', run_id: 'new-run' });
    f.lifecycle.settle('prior-run', 'work-1', true);
    expect(f.tasks.get(f.taskId)?.status).toBe('in_progress');
  });

  it('prevents generic todo writes from bypassing Project revision and acceptance checks', async () => {
    const f = createTask();
    const generic = createHostTaskApi(f.stores, f.projects);
    await expect(generic.updateTask(f.taskId, { status: 'completed' })).rejects.toThrow('revision-checked Project API');
    await expect(generic.deleteTask(f.taskId)).rejects.toThrow('revision-checked Project API');
    await expect(generic.claimTask(f.taskId, 'worker')).rejects.toThrow('revision-checked Project API');
    const ordinary = await generic.createTask(f.coordinatorId, { subject: 'Ordinary todo', description: 'Not a Project Task', owner: 'worker' });
    await expect(generic.blockTasks(f.taskId, ordinary.id)).rejects.toThrow('revision-checked Project API');
    await expect(generic.blockTasks(ordinary.id, f.taskId)).rejects.toThrow('revision-checked Project API');
    f.tasks.update(f.taskId, { owner: 'worker' });
    await expect(generic.unassignTeammateTasks(f.coordinatorId, 'worker')).rejects.toThrow('revision-checked Project API');
    expect((await generic.getTask(ordinary.id))?.owner).toBe('worker');
    expect(await generic.updateTask(ordinary.id, { status: 'completed' })).toMatchObject({ status: 'completed' });
    expect(await generic.deleteTask(ordinary.id)).toBe(true);
    expect(f.tasks.get(f.taskId)?.status).toBe('pending');
    expect(f.projects.getTaskLink(f.taskId)?.revision).toBe(0);
  });

  it('lets the real Coordinator project tool create/update but never accept or forge provenance', async () => {
    const f = createTask();
    const tool = createProjectToolService({ stores: { projects: f.projects }, projectApi: f.api });
    const created = await tool.dispatch({ callerSessionId: f.coordinatorId, action: 'create_task',
      payload: { requestId: 'second', subject: 'Independent Task', description: 'Defined before launch' } });
    expect(created).toMatchObject({ ok: true, task: { status: 'pending', workSessionId: null, revision: 0 } });
    const updated = await tool.dispatch({ callerSessionId: f.coordinatorId, action: 'update_task',
      payload: { taskId: f.taskId, expectedRevision: 0, subject: 'Edited title' } });
    expect(updated).toMatchObject({ ok: true, task: { subject: 'Edited title', revision: 1 } });
    for (const payload of [{ taskId: f.taskId, expectedRevision: 1, status: 'accepted' },
      { taskId: f.taskId, expectedRevision: 1, subject: 'Fake', source: { type: 'user_message', id: 'fake' } }]) {
      expect(await tool.dispatch({ callerSessionId: f.coordinatorId, action: 'update_task', payload })).toMatchObject({ ok: false });
    }
    expect(await tool.dispatch({ callerSessionId: f.coordinatorId, action: 'accept_task', payload: {} })).toMatchObject({ ok: false });
    expect(await tool.dispatch({ callerSessionId: 'worker', action: 'create_task', payload: {} })).toMatchObject({ ok: false, reason: 'not_project_coordinator' });
  });
});
