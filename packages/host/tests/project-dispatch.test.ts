import { describe, expect, it, vi } from 'vitest';
import { projectTaskFixture } from './project-task-fixture.js';
import {
  createProjectDispatchPort,
  type ProjectDispatchStores,
} from '../src/project/dispatch.js';
import {
  PROJECT_COORDINATOR_PROFILE_ID,
  PROJECT_WORK_SESSION_PROFILE_ID,
} from '../src/project/identity.js';

const PROJECT_ID = 'project-1';
const COORDINATOR_ID = 'coordinator-1';

function createHarness(options: { failTaskCreate?: boolean } = {}) {
  const fixture = projectTaskFixture(COORDINATOR_ID, PROJECT_ID);
  const { projects, tasks } = fixture;
  tasks.create({ id: 'task-old', sessionId: COORDINATOR_ID, subject: 'Old work', description: 'Continue it' });
  projects.bindTask(PROJECT_ID, 'task-old', COORDINATOR_ID);
  projects.bindWorkSession(PROJECT_ID, 'task-old', 'work-old');
  const create = vi.spyOn(tasks, 'create');
  const bindTask = vi.spyOn(projects, 'bindTask');
  const bindWork = vi.spyOn(projects, 'bindWorkSession');
  const update = vi.spyOn(tasks, 'update');
  if (options.failTaskCreate) create.mockImplementation(() => { throw new Error('disk full'); });
  const calls = {
    get create() { return create.mock.calls.length; },
    get bindTask() { return bindTask.mock.calls.length; },
    get bindWork() { return bindWork.mock.calls.length; },
    get update() { return update.mock.calls.length; },
  };
  return { ...fixture, get links() { return projects.listTaskLinks(PROJECT_ID); }, calls,
    port: createProjectDispatchPort(fixture.stores) };
}

const caller = {
  callerSessionId: COORDINATOR_ID,
  callerProfileId: PROJECT_COORDINATOR_PROFILE_ID,
};
const task = { subject: 'Implement billing', description: 'Ship the billing endpoint with tests' };

describe('project dispatch planning', () => {
  it('keeps ordinary Session spawns project-agnostic', () => {
    const { port } = createHarness();
    expect(port.planDispatch({
      callerSessionId: 'worker',
      callerProfileId: 'general-purpose',
      projectTask: undefined,
    })).toEqual({ kind: 'plain' });
    expect(port.planDispatch({
      callerSessionId: 'worker',
      callerProfileId: 'general-purpose',
      projectTask: task,
    })).toEqual({ kind: 'refused', reason: 'project_task_requires_project_coordinator' });
  });

  it('requires a canonical Project Task from a Coordinator', () => {
    const { port, calls } = createHarness();
    for (const invalid of [undefined, null, 'task', []]) {
      expect(port.planDispatch({ ...caller, projectTask: invalid }))
        .toEqual({ kind: 'refused', reason: 'project_coordinator_requires_project_task' });
    }
    expect(calls.create).toBe(0);
  });

  it('rejects malformed or oversized tasks without writing', () => {
    const { port, calls } = createHarness();
    for (const invalid of [
      { subject: '', description: 'x' },
      { subject: 'x', description: '' },
      { subject: 'x', description: 'y', extra: true },
      { subject: 'x'.repeat(161), description: 'y' },
      { subject: 'x', description: 'y'.repeat(12_001) },
    ]) {
      expect(port.planDispatch({ ...caller, projectTask: invalid }))
        .toEqual({ kind: 'refused', reason: 'invalid_project_task' });
    }
    expect(calls.create).toBe(0);
  });

  it('refuses a Coordinator that is not bound to a project', () => {
    const { port } = createHarness();
    expect(port.planDispatch({
      callerSessionId: 'other-coordinator',
      callerProfileId: PROJECT_COORDINATOR_PROFILE_ID,
      projectTask: task,
    })).toEqual({ kind: 'refused', reason: 'project_coordinator_not_bound' });
  });

  it('creates and binds exactly one pending Task on a valid plan', () => {
    const harness = createHarness();
    const plan = harness.port.planDispatch({ ...caller, projectTask: task });
    expect(plan).toEqual({ kind: 'project', projectId: PROJECT_ID, task });
    expect(harness.calls.create).toBe(0);
    if (plan.kind !== 'project') return;

    const created = harness.port.createTask(plan, COORDINATOR_ID);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(harness.tasks.get(created.taskId)).toMatchObject({
      sessionId: COORDINATOR_ID,
      subject: 'Implement billing',
      description: 'Ship the billing endpoint with tests',
      status: 'pending',
    });
    expect(harness.links.find((link) => link.task_id === created.taskId)).toMatchObject({
      coordinator_session_id: COORDINATOR_ID,
      work_session_id: null,
    });
    expect(harness.calls.bindTask).toBe(1);

    expect(harness.port.bindWorkSession(plan, created.taskId, 'work-1')).toBe(true);
    expect(harness.links.find((link) => link.task_id === created.taskId)?.work_session_id).toBe('work-1');

    harness.port.recordStartResult(created.taskId, 'running', undefined, 'run-1');
    expect(harness.tasks.get(created.taskId)?.status).toBe('in_progress');
    harness.port.recordStartResult(created.taskId, 'failed', 'worker failed', 'run-1');
    expect(harness.tasks.get(created.taskId)?.status).toBe('pending');
  });

  it('reports a Task create failure instead of spawning untracked work', () => {
    const harness = createHarness({ failTaskCreate: true });
    const plan = harness.port.planDispatch({ ...caller, projectTask: task });
    if (plan.kind !== 'project') throw new Error('expected a project plan');
    expect(harness.port.createTask(plan, COORDINATOR_ID))
      .toEqual({ ok: false, reason: 'project_task_create_failed:disk full' });
    expect(harness.links.some((link) => link.task_id !== 'task-old')).toBe(false);
  });
});

describe('project work Session authority', () => {
  it('authorizes through the project link instead of the old parent', () => {
    const { port } = createHarness();
    expect(port.authorizesWorkSession(PROJECT_COORDINATOR_PROFILE_ID, COORDINATOR_ID, 'work-old')).toBe(true);
    expect(port.authorizesWorkSession('general-purpose', COORDINATOR_ID, 'work-old')).toBe(false);
    expect(port.authorizesWorkSession(PROJECT_COORDINATOR_PROFILE_ID, COORDINATOR_ID, 'unrelated')).toBe(false);
    expect(port.authorizesWorkSession(PROJECT_COORDINATOR_PROFILE_ID, 'other-coordinator', 'work-old')).toBe(false);
  });

  it('lists only the work Sessions bound to the current project', () => {
    const { port } = createHarness();
    expect(port.listWorkSessionIds(PROJECT_COORDINATOR_PROFILE_ID, COORDINATOR_ID)).toEqual(['work-old']);
    expect(port.listWorkSessionIds('general-purpose', COORDINATOR_ID)).toEqual([]);
    expect(port.listWorkSessionIds(PROJECT_COORDINATOR_PROFILE_ID, 'other-coordinator')).toEqual([]);
  });

  it('runs dispatched work as a real work role', () => {
    const { port } = createHarness();
    expect(port.workSessionProfileId(PROJECT_COORDINATOR_PROFILE_ID)).toBe(PROJECT_WORK_SESSION_PROFILE_ID);
    expect(port.workSessionProfileId('general-purpose')).toBe('general-purpose');
    expect(port.workSessionProfileId(null)).toBeNull();
  });
});
