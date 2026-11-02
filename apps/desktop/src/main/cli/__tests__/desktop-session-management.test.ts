import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreDataHost } from '@duya/data/core-data-host';
import { createHostSessionApi, createHostWorkspaceRegistrationApi } from '@duya/host/session-api';
import { createDatabaseWorkspaceAccess } from '@duya/host/workspace-access';
import { SessionCheckoutService } from '@duya/host';
import { createDesktopSessionManagementService } from '../desktop-session-management';

const boundary = vi.hoisted(() => ({
  sessions: null as ReturnType<typeof createHostSessionApi> | null,
  service: null as ReturnType<typeof createDesktopSessionManagementService> | null,
}));
vi.mock('../desktop-host-api', () => ({
  getDesktopHostSessionApi: () => boundary.sessions,
  getDesktopSessionManagementService: () => boundary.service,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duya-coordinator-test', getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}));

import { dispatchDbAction } from '../../agents/db-bridge';

const cleanup: Array<() => void> = [];
afterEach(() => {
  boundary.sessions = null;
  boundary.service = null;
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function fixture(failure?: 'checkout' | 'start' | 'stale') {
  const root = mkdtempSync(join(tmpdir(), 'duya-desktop-coordinator-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const host = new CoreDataHost({
    filename: join(root, 'core.db'), rolloutRoot: join(root, 'sessions'), attachmentsRoot: join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:', parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
  cleanup.push(() => host.close());
  const workspaces = createDatabaseWorkspaceAccess(host.database.db, host.stores.workspaces);
  const binding = await createHostWorkspaceRegistrationApi(workspaces).registerLocalDirectory(root);
  const sessions = createHostSessionApi({ stores: host.stores, rolloutRoot: join(root, 'sessions'), workspaces });
  const parent = await sessions.create({
    id: 'coordinator', workspaceId: binding.workspaceId, workspaceRootId: binding.rootId,
    workspaceRelativePath: '', agentProfileId: 'project-coordinator',
  });
  host.stores.projects.insert({ project_id: 'project', canonical_root: root });
  host.stores.projects.bindCoordinatorSession('project', parent.id);
  host.stores.runs.createRun({ runId: 'parent-run', sessionId: parent.id, manifest: {}, manifestHash: 'test' });
  const caller = { sessionId: parent.id, runId: 'parent-run', epoch: host.stores.runs.currentEpoch('parent-run')! };
  const start = vi.fn(async (input: { sessionId: string }) => {
    expect(host.stores.projects.listTaskLinks('project')).toMatchObject([{ work_session_id: input.sessionId }]);
    expect(host.stores.tasks.getBySession(parent.id)[0]?.status).toBe('pending');
    if (failure === 'start') return { accepted: false, stage: 'refused_dispatch_failed', reason: 'start failed' } as const;
    return { accepted: true, stage: 'dispatched', runId: 'child-run' } as const;
  });
  const checkout = failure === 'checkout' ? {
    read: () => ({ checkout: null }),
    createChildCheckout: async () => { throw new Error('checkout failed'); },
  } : new SessionCheckoutService({ sessions: host.stores.sessions, runs: host.stores.runs });
  const service = createDesktopSessionManagementService({
    stores: host.stores,
    sessions: {
      ...sessions,
      create: async (input) => {
        const child = await sessions.create(input);
        if (failure === 'stale') host.database.db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(caller.runId);
        return child;
      },
    },
    checkoutService: checkout as Parameters<typeof createDesktopSessionManagementService>[0]['checkoutService'],
    execution: { startAgentRun: start, cancelAgentRun: async (runId) => ({ requested: true, runId }) },
  });
  boundary.sessions = sessions;
  boundary.service = service;
  const payload = { parentSessionId: parent.id, prompt: 'Implement the task', workingDirectory: root,
    projectTask: { subject: 'Project task', description: 'Deliver the requested change' } };
  return { host, parent, caller, payload, start };
}

describe('Desktop Coordinator Session management', () => {
  it('dispatches the real Desktop bridge through canonical Task binding and the work role', async () => {
    const f = await fixture();
    const result = await dispatchDbAction('session:spawn', f.payload, undefined, f.caller);
    expect(result).toMatchObject({ ok: true, taskId: expect.any(String), runId: 'child-run' });
    const [link] = f.host.stores.projects.listTaskLinks('project');
    expect(f.host.stores.tasks.get(link!.task_id)).toMatchObject({ subject: 'Project task', status: 'in_progress' });
    expect(f.host.stores.sessions.get(link!.work_session_id!)?.agentProfileId).toBe('code-expert');
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ agentProfileId: 'code-expert' }), f.caller);
  });

  it('refuses Coordinator dispatch without canonical task input or a trusted caller', async () => {
    const f = await fixture();
    expect(await dispatchDbAction('session:spawn', { ...f.payload, projectTask: undefined }, undefined, f.caller))
      .toMatchObject({ ok: false, reason: 'project_coordinator_requires_project_task' });
    expect(await dispatchDbAction('session:spawn', f.payload)).toMatchObject({ ok: false, reason: 'caller_attempt_not_current' });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.host.stores.tasks.getBySession(f.parent.id)).toEqual([]);
  });

  it.each(['checkout', 'start', 'stale'] as const)('keeps Task pending when %s prevents a child Run', async (failure) => {
    const f = await fixture(failure);
    expect(await dispatchDbAction('session:spawn', f.payload, undefined, f.caller)).toMatchObject({ ok: false });
    expect(f.host.stores.tasks.getBySession(f.parent.id)).toMatchObject([{ status: 'pending' }]);
    if (failure !== 'start') expect(f.start).not.toHaveBeenCalled();
  });
});
