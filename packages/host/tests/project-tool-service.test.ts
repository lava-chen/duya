import { describe, expect, it, vi } from 'vitest';
import type { HostProjectApiV1, ProjectContinuitySnapshot } from '@duya/agent-protocol/projects';
import { createProjectToolService } from '../src/project/tool-service.js';

const PROJECT_ID = 'project-1';
const COORDINATOR_ID = 'coordinator-1';

function snapshot(): ProjectContinuitySnapshot {
  return {
    project: {
      project_id: PROJECT_ID,
      canonical_root: 'E:/project',
      name: 'Project',
      description: null,
      paths: [],
      icon: null,
      color: null,
      created_at: 1,
      last_seen_at: 2,
      coordinator_session_id: COORDINATOR_ID,
    },
    state: {
      revision: 3,
      currentState: 'Billing endpoint is implemented',
      nextStep: 'Collect user acceptance',
      source: { type: 'session', id: COORDINATOR_ID },
      updatedAt: 10,
    },
    tasks: [{
      task: {
        id: 'task-1', sessionId: COORDINATOR_ID, subject: 'Implement billing', description: 'Ship it',
        status: 'in_progress', priority: 'medium', createdAt: 1, updatedAt: 2,
        extensions: {}, subjectKey: 'implement billing',
      } as never,
      link: {
        projectId: PROJECT_ID, taskId: 'task-1', coordinatorSessionId: COORDINATOR_ID,
        workSessionId: 'work-1', updatedAt: 2, acceptanceStatus: 'pending',
      },
    }],
    decisions: [{
      key: 'api-shape', content: 'Use the REST endpoint', status: 'accepted', revision: 2,
      source: { type: 'user_message', id: 'message-1' }, updatedAt: 5,
    }],
    memories: [{
      key: 'style', content: 'Prefer small modules', status: 'active', revision: 1,
      source: { type: 'user_message', id: 'message-2' }, updatedAt: 6,
    }],
    activity: [{
      cursor: 7, type: 'run.terminal', taskId: 'task-1', sessionId: 'work-1', runId: 'run-1',
      source: { type: 'run', id: 'run-1' }, payload: { status: 'completed' }, createdAt: 9,
    }],
    nextCursor: 7,
    transcriptRefs: [{ sessionId: COORDINATOR_ID, role: 'coordinator' }],
  };
}

function harness(options: { coordinator?: string | null } = {}) {
  const projectApi = {
    getProjectContinuity: vi.fn(async () => snapshot()),
    getProjectContext: vi.fn(async () => ({
      text: 'Durable project context',
      sourceRefs: [{ type: 'project', id: PROJECT_ID }],
    })),
    // The durable write APIs stay in the Host for the control plane; the tool
    // must never reach them.
    updateProjectState: vi.fn(),
    updateProjectDecision: vi.fn(),
    updateProjectMemory: vi.fn(),
  };
  const service = createProjectToolService({
    stores: {
      projects: {
        getTaskLinkByWorkSession: (sessionId: string) => sessionId === 'work-1' ? { project_id: PROJECT_ID, task_id: 'task-1' } : null,
        getByCoordinatorSession: (sessionId: string) =>
          sessionId === (options.coordinator === undefined ? COORDINATOR_ID : options.coordinator)
            ? { project_id: PROJECT_ID }
            : null,
      } as never,
    },
    projectApi: projectApi as unknown as Pick<
      HostProjectApiV1,
      'getProjectContinuity' | 'getProjectContext'
    >,
  });
  return { service, projectApi };
}

describe('project tool service', () => {
  it('refuses a caller that is not the bound Coordinator without touching the project', async () => {
    const { service, projectApi } = harness({ coordinator: null });

    const result = await service.dispatch({ action: 'get', payload: {}, callerSessionId: 'someone-else' });

    expect(result).toEqual({ ok: false, reason: 'not_project_coordinator' });
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });

  it('resolves the project from the binding and pages activity with the requested limit', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({
      action: 'get',
      payload: { afterCursor: 2, limit: 5 },
      callerSessionId: COORDINATOR_ID,
    });

    expect(projectApi.getProjectContinuity).toHaveBeenCalledWith(PROJECT_ID, { afterCursor: 2, limit: 5 });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        tasks: [{ taskId: 'task-1', acceptanceStatus: 'pending', workSessionId: 'work-1', recordAvailable: true }],
        activity: [{ cursor: 7, type: 'run.terminal', runId: 'run-1' }],
        nextCursor: 7,
      },
    });
  });

  it('projects tasks and activity only', async () => {
    const { service } = harness();

    const result = await service.dispatch({ action: 'get', payload: {}, callerSessionId: COORDINATOR_ID });

    const projected = (result as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    expect(Object.keys(projected).sort()).toEqual(['activity', 'nextCursor', 'tasks']);
  });

  it('never reaches the durable write APIs', async () => {
    const { service, projectApi } = harness();

    await service.dispatch({ action: 'get', payload: {}, callerSessionId: COORDINATOR_ID });

    expect(projectApi.updateProjectState).not.toHaveBeenCalled();
    expect(projectApi.updateProjectDecision).not.toHaveBeenCalled();
    expect(projectApi.updateProjectMemory).not.toHaveBeenCalled();
  });

  it('refuses the removed context and write actions', async () => {
    const { service, projectApi } = harness();

    for (const action of ['context', 'update_state', 'record_decision', 'record_memory']) {
      const result = await service.dispatch({ action, payload: {}, callerSessionId: COORDINATOR_ID });

      expect(result).toEqual({ ok: false, reason: `unsupported_action:${action}` });
    }
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });

  it('rejects an unknown action before resolving the project', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({ action: 'accept_task', payload: {}, callerSessionId: COORDINATOR_ID });

    expect(result).toEqual({ ok: false, reason: 'unsupported_action:accept_task' });
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });

  it('builds the bounded prompt context for a bound session', async () => {
    const { service, projectApi } = harness();

    const result = await service.getSessionContext(COORDINATOR_ID);

    expect(projectApi.getProjectContext).toHaveBeenCalledWith(PROJECT_ID, undefined, 8000);
    expect(result).toMatchObject({ text: 'Durable project context', role: 'coordinator', projectId: PROJECT_ID });
  });
});
