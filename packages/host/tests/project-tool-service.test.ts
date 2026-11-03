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

function harness(options: { coordinator?: string | null; updateState?: 'ok' | 'conflict' } = {}) {
  const projectApi = {
    getProjectContinuity: vi.fn(async () => snapshot()),
    getProjectContext: vi.fn(async () => ({
      text: 'Durable project context',
      sourceRefs: [{ type: 'project', id: PROJECT_ID }],
    })),
    updateProjectState: vi.fn(async (input: { currentState: string; nextStep: string }) =>
      options.updateState === 'conflict'
        ? null
        : {
            revision: 4,
            currentState: input.currentState,
            nextStep: input.nextStep,
            source: { type: 'session', id: COORDINATOR_ID },
            updatedAt: 11,
          }),
    updateProjectDecision: vi.fn(async () => ({
      key: 'api-shape', content: 'Use the REST endpoint', status: 'proposed' as const, revision: 3,
      source: { type: 'session', id: COORDINATOR_ID }, updatedAt: 12,
    })),
    updateProjectMemory: vi.fn(async () => ({
      key: 'style', content: 'Prefer small modules', status: 'candidate' as const, revision: 2,
      source: { type: 'session', id: COORDINATOR_ID }, updatedAt: 13,
    })),
  };
  const service = createProjectToolService({
    stores: {
      projects: {
        getByCoordinatorSession: (sessionId: string) =>
          sessionId === (options.coordinator === undefined ? COORDINATOR_ID : options.coordinator)
            ? { project_id: PROJECT_ID }
            : null,
      } as never,
    },
    projectApi: projectApi as unknown as Pick<
      HostProjectApiV1,
      | 'getProjectContinuity'
      | 'getProjectContext'
      | 'updateProjectState'
      | 'updateProjectDecision'
      | 'updateProjectMemory'
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
        project: { projectId: PROJECT_ID },
        state: { revision: 3 },
        tasks: [{ taskId: 'task-1', acceptanceStatus: 'pending', workSessionId: 'work-1', recordAvailable: true }],
        decisions: [{ key: 'api-shape', status: 'accepted' }],
        memories: [{ key: 'style', status: 'active' }],
        activity: [{ cursor: 7, type: 'run.terminal', runId: 'run-1' }],
        nextCursor: 7,
      },
    });
  });

  it('writes state with the calling Session as provenance', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({
      action: 'update_state',
      payload: { expectedRevision: 3, currentState: 'Merged', nextStep: 'Ask for acceptance' },
      callerSessionId: COORDINATOR_ID,
    });

    expect(projectApi.updateProjectState).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedRevision: 3,
      currentState: 'Merged',
      nextStep: 'Ask for acceptance',
      source: { type: 'session', id: COORDINATOR_ID },
    });
    expect(result).toMatchObject({ ok: true, state: { revision: 4 } });
  });

  it('maps a stale revision to a conflict without inventing a write', async () => {
    const { service } = harness({ updateState: 'conflict' });

    const result = await service.dispatch({
      action: 'update_state',
      payload: { expectedRevision: 2, currentState: 'Stale' },
      callerSessionId: COORDINATOR_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'revision_conflict' });
  });

  it('refuses decision acceptance and memory activation as user-only actions', async () => {
    const { service, projectApi } = harness();

    const decision = await service.dispatch({
      action: 'record_decision',
      payload: { expectedRevision: 0, key: 'k', content: 'c', status: 'accepted' },
      callerSessionId: COORDINATOR_ID,
    });
    const memory = await service.dispatch({
      action: 'record_memory',
      payload: { expectedRevision: 0, key: 'k', content: 'c', status: 'active' },
      callerSessionId: COORDINATOR_ID,
    });

    expect(decision).toEqual({ ok: false, reason: 'user_action_required' });
    expect(memory).toEqual({ ok: false, reason: 'user_action_required' });
    expect(projectApi.updateProjectDecision).not.toHaveBeenCalled();
    expect(projectApi.updateProjectMemory).not.toHaveBeenCalled();
  });

  it('records proposals and candidates with a session source', async () => {
    const { service, projectApi } = harness();

    const decision = await service.dispatch({
      action: 'record_decision',
      payload: { expectedRevision: 2, key: 'api-shape', content: 'Use REST', status: 'proposed' },
      callerSessionId: COORDINATOR_ID,
    });
    const memory = await service.dispatch({
      action: 'record_memory',
      payload: { expectedRevision: 1, key: 'style', content: 'Small modules', status: 'candidate' },
      callerSessionId: COORDINATOR_ID,
    });

    expect(decision).toMatchObject({ ok: true, decision: { key: 'api-shape', status: 'proposed' } });
    expect(memory).toMatchObject({ ok: true, memory: { key: 'style', status: 'candidate' } });
    expect(projectApi.updateProjectDecision).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: 'session', id: COORDINATOR_ID },
    }));
    expect(projectApi.updateProjectMemory).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: 'session', id: COORDINATOR_ID },
    }));
  });

  it('builds bounded context for one task', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({
      action: 'context',
      payload: { taskId: 'task-1', maxCharacters: 1200 },
      callerSessionId: COORDINATOR_ID,
    });

    expect(projectApi.getProjectContext).toHaveBeenCalledWith(PROJECT_ID, 'task-1', 1200);
    expect(result).toMatchObject({ ok: true, context: { text: 'Durable project context' } });
  });

  it('rejects an unknown action before resolving the project', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({ action: 'accept_task', payload: {}, callerSessionId: COORDINATOR_ID });

    expect(result).toEqual({ ok: false, reason: 'unsupported_action:accept_task' });
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });
});
