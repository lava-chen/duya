import { describe, expect, it } from 'vitest';
import type { HostSessionRecord } from '@duya/agent-protocol/session-api';
import { createHostSessionService } from '../src/session-service.js';
import { createProjectDispatchPort } from '../src/project/dispatch.js';

describe('Project work Session continuity', () => {
  it('lets the currently bound Coordinator find and continue a prior Coordinator work Session', async () => {
    const workspace = process.cwd();
    const coordinator: HostSessionRecord = {
      id: 'coordinator-new',
      workspace: { state: 'bound', workspaceId: 'workspace', rootId: 'root', relativePath: '' },
      title: 'Coordinator', projectName: 'Project', status: 'active', model: 'model', providerId: null,
      mode: 'chat', permissionMode: 'auto', agentProfileId: 'project-coordinator', parentSessionId: null,
      agentType: 'chat', agentName: '', draft: null, extensions: {}, createdAt: 1, updatedAt: 1,
      recencyAt: null, lastTurnStartedAt: null,
    };
    const work: HostSessionRecord = {
      ...coordinator,
      id: 'work-old', title: 'Old project work', agentProfileId: 'code-expert',
      parentSessionId: 'coordinator-old', agentType: 'spawn',
      extensions: { 'host.sessionSpawn': { status: 'completed', runId: 'run-old' } },
    };
    const records = new Map([[coordinator.id, coordinator], [work.id, work]]);
    const starts: string[] = [];
    let runSequence = 0;
    const caller = { sessionId: coordinator.id, runId: 'coordinator-run', epoch: 1 };
    const service = createHostSessionService({
      sessions: {
        get: async (id: string) => records.get(id) ?? null,
        list: async () => ({ sessions: [], nextCursor: null }),
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
        getAgentRun: async (runId: string) => runId === 'run-old'
          ? { runId, sessionId: work.id, status: 'completed', terminal: null, metrics: null, origin: null,
            parentRunId: null, createdAt: 1, startedAt: 1, finishedAt: 2, manifest: {} as never,
            manifestHash: 'hash', inputHash: null }
          : null,
        readAgentRunEvents: async () => [],
        listAgentRunsBySession: async () => [],
      } as never,
      execution: {
        startAgentRun: async ({ sessionId, prompt }: { sessionId: string; prompt: string }) => {
          starts.push(`${sessionId}:${prompt}`);
          const runId = `run-${++runSequence}`;
          return { accepted: true, stage: 'dispatched', runId };
        },
        cancelAgentRun: async () => ({ requested: true }),
      } as never,
      readLocalSession: async (id: string) => records.has(id)
        ? { id, workingDirectory: workspace, extensions: {} } as never
        : null,
      projectDispatch: createProjectDispatchPort({
        projects: {
          getByCoordinatorSession: (id: string) => id === coordinator.id ? { project_id: 'project-1' } : null,
          listTaskLinks: () => [{ work_session_id: work.id }],
          bindTask: () => { throw new Error('not used'); },
          bindWorkSession: () => null,
        } as never,
        tasks: { create: () => undefined, update: () => undefined } as never,
      }),
      validateCaller: (value) => {
        if (value.sessionId !== caller.sessionId || value.runId !== caller.runId || value.epoch !== caller.epoch) {
          throw new Error('caller attempt is not current');
        }
      },
    });

    const listed = await service.dispatch('session:spawnList', {}, caller) as { ok: boolean; sessions: Array<{ id: string }> };
    const queried = await service.dispatch('session:spawnGet', { sessionId: work.id }, caller) as { ok: boolean };
    const continued = await service.dispatch('session:spawnReply', { sessionId: work.id, prompt: 'continue task' }, caller) as { ok: boolean };

    expect(listed.sessions.map(({ id }) => id)).toContain(work.id);
    expect(queried.ok).toBe(true);
    expect(continued.ok).toBe(true);
    expect(starts).toEqual(['work-old:continue task']);
  });
});
