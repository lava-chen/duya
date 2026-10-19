// @vitest-environment jsdom
/**
 * The browser half of the IPC client.
 *
 * The shared renderer runs on a host it did not choose: Electron provides
 * `window.electronAPI`, the browser does not. Every read the browser reaches
 * has to answer from the seam instead of the preload, and a read that still
 * reaches for the preload must fail as an EMPTY answer rather than take the
 * whole load down with it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { HostSessionRecord } from '@duya/agent-protocol';
import { clearUiServices, configureUiServices, type UiServices } from '@/services';
import { getProjectGroupsIPC, listProvidersIPC, listThreadsIPC } from './ipc-client';

const SESSION_ID = 'session-browser-1' as HostSessionRecord['id'];

function hostSession(overrides: Partial<HostSessionRecord> = {}): HostSessionRecord {
  return {
    id: SESSION_ID,
    workspace: { state: 'bound', workspaceId: 'ws-1' as HostSessionRecord['id'], rootId: null, relativePath: 'workspace' },
    title: 'Browser session',
    projectName: 'Browser project',
    status: 'active',
    model: 'proof-model',
    providerId: 'browser-proof',
    mode: 'code',
    permissionMode: 'default',
    agentProfileId: null,
    parentSessionId: null,
    agentType: 'main',
    agentName: 'Duya',
    draft: null,
    extensions: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    recencyAt: 1_700_000_000_000,
    lastTurnStartedAt: null,
    ...overrides,
  };
}

function servicesWith(sessions: readonly HostSessionRecord[]): UiServices {
  return {
    platform: 'web',
    capabilities: {
      localFileAccess: false,
      settings: false,
      extensions: false,
      conductor: false,
      bots: false,
      automation: false,
      workflows: false,
    },
    sessions: {
      list: async () => ({ sessions: sessions.map((session) => ({ session, timelineCount: 0 })), nextCursor: null }),
      get: async () => null,
      create: async () => { throw new Error('not used'); },
      update: async () => { throw new Error('not used'); },
      delete: async () => { throw new Error('not used'); },
      readMessages: async () => { throw new Error('not used'); },
    },
    runs: {
      listBySession: async () => [],
      start: async () => { throw new Error('not used'); },
      cancel: async () => { throw new Error('not used'); },
      openSession: () => { throw new Error('not used'); },
    },
    approvals: {
      listPending: async () => [],
      resolve: async () => null,
    },
  };
}

afterEach(() => {
  clearUiServices(servicesWith([]));
});

describe('ipc-client on a host that is not Electron', () => {
  it('answers the project roster with an empty list instead of failing the load', async () => {
    // No preload: the browser surface has no project table.
    await expect(getProjectGroupsIPC()).resolves.toEqual([]);
  });

  it('answers the provider roster with an empty list instead of failing the fetch', async () => {
    // No preload: the browser surface has no provider configuration, and the
    // Host owns the model a run uses.
    await expect(listProvidersIPC()).resolves.toEqual([]);
  });

  it('lists the sessions the seam reports', async () => {
    const services = servicesWith([hostSession()]);
    configureUiServices(services);

    const threads = await listThreadsIPC();

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: SESSION_ID,
      title: 'Browser session',
      projectName: 'Browser project',
      workingDirectory: 'workspace',
    });
    clearUiServices(services);
  });
});
