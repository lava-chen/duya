import { describe, expect, it, vi } from 'vitest';
import { ProjectTool } from '../src/project/tool.js';
import type {
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolPort,
  ProjectToolSnapshot,
} from '../src/project/ports.js';

const snapshot: ProjectToolSnapshot = {
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
  it('renders the task and activity projection with acceptance and provenance', async () => {
    const { tool, dispatch } = harness({ ok: true, snapshot });

    const result = await tool.execute({ action: 'get', afterCursor: 2, limit: 5 });

    expect(dispatch).toHaveBeenCalledWith({ action: 'get', payload: { afterCursor: 2, limit: 5 } });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Tasks (1)');
    expect(result.result).toContain('task-1 [in_progress · acceptance=pending · work work-1] Implement billing');
    expect(result.result).toContain('#7 run.terminal · task=task-1 session=work-1 run=run-1');
    expect(result.result).toContain('Activity cursor: 7');
  });

  it('returns tasks and activity only', async () => {
    const { tool } = harness({ ok: true, snapshot });

    const result = await tool.execute({ action: 'get' });

    expect(result.result).not.toContain('Decisions');
    expect(result.result).not.toContain('Memories');
    expect(result.result).not.toContain('State:');
    expect(result.result).not.toContain('revision');
  });

  it('explains a refused coordinator binding', async () => {
    const { tool } = harness({ ok: false, reason: 'not_project_coordinator' });

    const result = await tool.execute({ action: 'get' });

    expect(result.error).toBe(true);
    expect(result.result).toContain('not the currently bound Project Coordinator');
  });

  it('rejects an out-of-range activity limit before reaching the Host', async () => {
    const { tool, dispatch } = harness({ ok: true, snapshot });

    const result = await tool.execute({ action: 'get', limit: 1000 });

    expect(result.error).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses the removed context and write actions', async () => {
    const { tool, dispatch } = harness({ ok: true, snapshot });

    for (const action of ['context', 'update_state', 'record_decision', 'record_memory']) {
      const result = await tool.execute({ action });

      expect(result.error).toBe(true);
      expect(result.result).toContain(`action "${action}" is not supported.`);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
});
