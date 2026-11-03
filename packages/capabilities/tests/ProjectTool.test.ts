import { describe, expect, it, vi } from 'vitest';
import { ProjectTool } from '../src/project/tool.js';
import type {
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolPort,
  ProjectToolSnapshot,
} from '../src/project/ports.js';

const snapshot: ProjectToolSnapshot = {
  project: { projectId: 'project-1', name: 'Project', coordinatorSessionId: 'coordinator-1' },
  state: {
    revision: 3,
    currentState: 'Billing endpoint is implemented',
    nextStep: 'Collect user acceptance',
    source: { type: 'session', id: 'coordinator-1' },
    updatedAt: 10,
  },
  tasks: [{
    taskId: 'task-1',
    subject: 'Implement billing',
    description: 'Ship it',
    status: 'in_progress',
    acceptanceStatus: 'pending',
    workSessionId: 'work-1',
    updatedAt: 2,
    recordAvailable: true,
  }],
  decisions: [{
    key: 'api-shape',
    content: 'Use the REST endpoint',
    status: 'accepted',
    revision: 2,
    source: { type: 'user_message', id: 'message-1' },
    updatedAt: 5,
  }],
  memories: [{
    key: 'style',
    content: 'Prefer small modules',
    status: 'active',
    revision: 1,
    source: { type: 'user_message', id: 'message-2' },
    updatedAt: 6,
  }],
  activity: [{
    cursor: 7,
    type: 'run.terminal',
    taskId: 'task-1',
    sessionId: 'work-1',
    runId: 'run-1',
    source: { type: 'run', id: 'run-1' },
    payload: { status: 'completed' },
    createdAt: 9,
  }],
  nextCursor: 7,
};

function harness(result: ProjectToolOperation<ProjectToolPayload>) {
  const dispatch = vi.fn(async () => result);
  const tool = new ProjectTool({ dispatch } as ProjectToolPort);
  return { tool, dispatch };
}

describe('project capability tool', () => {
  it('renders the durable snapshot with task acceptance and provenance', async () => {
    const { tool, dispatch } = harness({ ok: true, snapshot });

    const result = await tool.execute({ action: 'get', afterCursor: 2, limit: 5 });

    expect(dispatch).toHaveBeenCalledWith({ action: 'get', payload: { afterCursor: 2, limit: 5 } });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Project: Project (project-1)');
    expect(result.result).toContain('revision 3');
    expect(result.result).toContain('task-1 [in_progress · acceptance=pending · work work-1] Implement billing');
    expect(result.result).toContain('[accepted r2] api-shape — Use the REST endpoint (user_message:message-1)');
    expect(result.result).toContain('[active r1] style — Prefer small modules (user_message:message-2)');
    expect(result.result).toContain('#7 run.terminal · task=task-1 session=work-1 run=run-1');
  });

  it('explains a refused coordinator binding', async () => {
    const { tool } = harness({ ok: false, reason: 'not_project_coordinator' });

    const result = await tool.execute({ action: 'get' });

    expect(result.error).toBe(true);
    expect(result.result).toContain('not the currently bound Project Coordinator');
  });

  it('tells the model that accepted and active are user actions', async () => {
    const { tool } = harness({ ok: false, reason: 'user_action_required' });

    const result = await tool.execute({
      action: 'record_decision',
      expectedRevision: 0,
      key: 'api-shape',
      content: 'Use REST',
      status: 'accepted',
    });

    expect(result.error).toBe(true);
    expect(result.result).toContain('requires an explicit user action');
  });

  it('rejects an out-of-range activity limit before reaching the Host', async () => {
    const { tool, dispatch } = harness({ ok: true, snapshot });

    const result = await tool.execute({ action: 'get', limit: 1000 });

    expect(result.error).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('requires an expected revision for writes', async () => {
    const { tool, dispatch } = harness({ ok: true, state: snapshot.state! });

    const result = await tool.execute({ action: 'update_state', currentState: 'Merged' });

    expect(result.error).toBe(true);
    expect(result.result).toContain('expectedRevision is required');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('builds context with sources', async () => {
    const { tool, dispatch } = harness({
      ok: true,
      context: { text: 'Durable project context', sourceRefs: [{ type: 'project', id: 'project-1' }] },
    });

    const result = await tool.execute({ action: 'context', taskId: 'task-1' });

    expect(dispatch).toHaveBeenCalledWith({ action: 'context', payload: { taskId: 'task-1' } });
    expect(result.result).toContain('Durable project context');
    expect(result.result).toContain('Sources: project:project-1');
  });
});
