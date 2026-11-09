import { describe, expect, it } from 'vitest';
import type { HostSessionRecord } from '@duya/agent-protocol/session-api';
import { createHostSessionService } from '../src/session-service.js';
import { createProjectDispatchPort } from '../src/project/dispatch.js';

/**
 * A Coordinator dispatch creates the canonical Task BEFORE the child Session
 * is created, bound and started. Every failure in that window must put the
 * Task back: a Task whose child never started is not dispatched work, and
 * leaving it at in_progress would make the project report a phantom worker.
 *
 * Before this fix only two of the five failure paths rolled the Task back —
 * `bindWorkSession` failure and `startRun` failure. These tests cover the
 * remaining three (child create, caller expiry, checkout) plus the symmetric
 * success case, so a future early return cannot silently reintroduce the gap.
 */

const COORDINATOR_ID = 'coordinator-1';
const PROJECT_ID = 'project-1';
const CHILD_ID = 'child-1';

type Failure = 'none' | 'session-create' | 'caller-lost' | 'checkout' | 'start-run';

interface FakeLink {
  project_id: string;
  task_id: string;
  coordinator_session_id: string;
  work_session_id: string | null;
  updated_at: number;
  acceptance_status: 'pending';
}

function createHarness(failure: Failure) {
  const cwd = process.cwd();
  const coordinator: HostSessionRecord = {
    id: COORDINATOR_ID,
    workspace: { state: 'bound', workspaceId: 'workspace', rootId: 'root', relativePath: '' },
    title: 'Coordinator', projectName: 'Project', status: 'active', model: 'model', providerId: null,
    mode: 'chat', permissionMode: 'auto', agentProfileId: 'project-coordinator', parentSessionId: null,
    agentType: 'chat', agentName: '', draft: null, extensions: {}, createdAt: 1, updatedAt: 1,
    recencyAt: null, lastTurnStartedAt: null,
  };
  const child: HostSessionRecord = {
    ...coordinator,
    id: CHILD_ID,
    title: 'Work',
    agentProfileId: 'code-expert',
    parentSessionId: COORDINATOR_ID,
    agentType: 'spawn',
  };
  const records = new Map<string, HostSessionRecord>([[COORDINATOR_ID, coordinator]]);
  const links: FakeLink[] = [];
  const tasks = new Map<string, { id: string; status: string }>();
  const statusWrites: string[] = [];
  let callerLost = false;

  const port = createProjectDispatchPort({
    projects: {
      getByCoordinatorSession: (id: string) => id === COORDINATOR_ID ? { project_id: PROJECT_ID } : null,
      listTaskLinks: () => links,
      bindTask: (projectId: string, taskId: string, coordinatorSessionId: string) => {
        const link: FakeLink = {
          project_id: projectId, task_id: taskId, coordinator_session_id: coordinatorSessionId,
          work_session_id: null, updated_at: 2, acceptance_status: 'pending',
        };
        links.push(link);
        return link;
      },
      bindWorkSession: (_projectId: string, taskId: string, workSessionId: string) => {
        const link = links.find((row) => row.task_id === taskId);
        if (!link) return null;
        link.work_session_id = workSessionId;
        if (failure === 'caller-lost') callerLost = true;
        return link;
      },
    } as never,
    tasks: {
      create: (input: { id: string; status?: string }) => {
        const task = { id: input.id, status: input.status ?? 'pending' };
        tasks.set(input.id, task);
        return task;
      },
      update: (id: string, patch: { status?: string }) => {
        const task = tasks.get(id);
        if (!task) return null;
        if (patch.status !== undefined) {
          task.status = patch.status;
          statusWrites.push(patch.status);
        }
        return task;
      },
    } as never,
  });

  const service = createHostSessionService({
    sessions: {
      get: async (id: string) => records.get(id) ?? null,
      list: async () => ({ sessions: [], nextCursor: null }),
      create: async () => {
        if (failure === 'session-create') throw new Error('child session create failed');
        records.set(CHILD_ID, child);
        return child;
      },
      update: async (id: string, _expected: number | undefined, patch: { extensions?: Record<string, unknown> }) => {
        const existing = records.get(id);
        if (!existing) return { updated: false, reason: 'not_found' };
        const updated = { ...existing, extensions: { ...existing.extensions, ...(patch.extensions ?? {}) } };
        records.set(id, updated);
        return { updated: true, session: updated };
      },
      getSessionChangeStats: async () => ({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 }),
    } as never,
    runs: {
      getAgentRun: async () => null,
      readAgentRunEvents: async () => [],
      listAgentRunsBySession: async () => [],
    } as never,
    execution: {
      startAgentRun: async () => {
        if (failure === 'start-run') throw new Error('child run refused');
        return { accepted: true, stage: 'dispatched', runId: 'run-child' };
      },
      cancelAgentRun: async () => ({ requested: true }),
    } as never,
    readLocalSession: async (id: string) => id === COORDINATOR_ID
      ? { id, workingDirectory: cwd, extensions: {} } as never
      : null,
    validateCaller: (value) => {
      if (callerLost || value.sessionId !== COORDINATOR_ID || value.runId !== 'run-c' || value.epoch !== 1) {
        throw new Error('caller attempt is not current');
      }
    },
    projectDispatch: port,
    ...(failure === 'checkout' ? {
      checkoutService: {
        read: () => ({ checkout: null }),
        createChildCheckout: async () => { throw new Error('checkout failed'); },
      } as never,
    } : {}),
  });

  const caller = { sessionId: COORDINATOR_ID, runId: 'run-c', epoch: 1 };
  const spawn = () => service.dispatch('session:spawn', {
    prompt: 'do the work',
    workingDirectory: cwd,
    use_worktree: false,
    projectTask: { subject: 'Build it', description: 'Build the thing' },
  }, caller);

  return { spawn, statusWrites, tasks, links };
}

describe('Project dispatch failure reconciliation', () => {
  it('a successful dispatch commits the Task as in_progress', async () => {
    const harness = createHarness('none');

    const result = await harness.spawn() as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(harness.statusWrites).toEqual(['in_progress']);
    expect([...harness.tasks.values()][0]?.status).toBe('in_progress');
  });

  for (const [failure, reason] of [
    ['session-create', 'child session create failed'],
    ['caller-lost', 'caller_attempt_not_current'],
    ['checkout', 'checkout failed'],
    ['start-run', 'child run refused'],
  ] as const) {
    it(`rolls the Task back when ${failure} fails`, async () => {
      const harness = createHarness(failure);

      const result = await harness.spawn() as { ok: boolean; reason: string };

      expect(result.ok).toBe(false);
      expect(result.reason).toContain(reason);
      expect(harness.statusWrites).toEqual(['pending']);
      expect(harness.statusWrites).not.toContain('in_progress');
      expect([...harness.tasks.values()][0]?.status).toBe('pending');
    });
  }
});
