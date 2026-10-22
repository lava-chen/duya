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
import type { HostMessageItem, HostSessionRecord } from '@duya/agent-protocol';
import { clearUiServices, configureUiServices, type UiServices } from '@/services';
import { mapIpcMessagesToStore } from '@/stores/conversation-store';
import { mergeRunSessionRows } from './run-session-view';
import { getProjectGroupsIPC, getThreadIPC, listProvidersIPC, listThreadsIPC } from './ipc-client';

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
      turnConfiguration: true,
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
  it('preserves Host run identity through history loading and store projection for run de-duplication', async () => {
    const hostMessage = {
      id: 'assistant-row-1',
      sequence: 4,
      createdAt: 1_700_000_000_004,
      turnId: 'turn-1',
      entry: {
        type: 'message',
        id: 'assistant-row-1',
        parentId: null,
        createdAt: 1_700_000_000_004,
        runId: 'run-current',
        message: { role: 'assistant', content: 'answer', visibility: 'visible' },
      },
    } as unknown as HostMessageItem;
    const base = servicesWith([hostSession()]);
    configureUiServices({
      ...base,
      sessions: {
        ...base.sessions,
        get: async () => hostSession(),
        readMessages: async () => ({ sessionId: SESSION_ID, messages: [hostMessage], nextCursor: null }),
      },
    });

    const loaded = await getThreadIPC(SESSION_ID);
    expect(loaded).not.toBeNull();
    const durable = mapIpcMessagesToStore(loaded!.messages);
    const snapshot = {
      runId: 'run-current',
      sessionId: SESSION_ID,
      timeline: [{ seq: 2, payload: { type: 'assistant.text_block', messageId: 'message-1', text: 'answer' } }],
      messages: [{ messageId: 'message-1', text: 'answer', thinking: '', finalized: true }],
      toolCalls: [],
    } as unknown as import('@duya/client-core').RunSessionSnapshot;

    expect(durable[0]?.runId).toBe('run-current');
    expect(mergeRunSessionRows(durable, snapshot).filter((message) => message.content === 'answer')).toHaveLength(1);
  });

  it('keeps the durable row identity a persisted tool result needs to pair with its call', async () => {
    const rows = [
      {
        id: 'assistant-tool-row',
        sequence: 2,
        createdAt: 1_700_000_000_002,
        turnId: 'turn-1',
        entry: {
          type: 'message',
          id: 'assistant-tool-row',
          parentId: null,
          createdAt: 1_700_000_000_002,
          runId: 'run-tools',
          message: {
            role: 'assistant',
            visibility: 'visible',
            msg_type: 'text',
            content: [{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo hi' } }],
          },
        },
      },
      {
        id: 'approval-row',
        sequence: 3,
        createdAt: 1_700_000_000_003,
        turnId: null,
        entry: {
          type: 'message',
          id: 'approval-row',
          parentId: null,
          createdAt: 1_700_000_000_003,
          runId: 'run-tools',
          message: {
            role: 'assistant',
            visibility: 'visible',
            msg_type: 'tool-approval',
            status: 'complete',
            content: 'Approval needed: bash',
          },
        },
      },
      {
        id: 'tool-result-row',
        sequence: 4,
        createdAt: 1_700_000_000_004,
        turnId: 'turn-1',
        entry: {
          type: 'message',
          id: 'tool-result-row',
          parentId: null,
          createdAt: 1_700_000_000_004,
          runId: 'run-tools',
          message: {
            role: 'tool',
            visibility: 'visible',
            msg_type: 'tool_result',
            tool_call_id: 'call-1',
            parent_tool_call_id: 'call-1',
            status: 'done',
            duration_ms: 42,
            content: '[completed] bash\nhi',
          },
        },
      },
    ] as unknown as HostMessageItem[];
    const base = servicesWith([hostSession()]);
    configureUiServices({
      ...base,
      sessions: {
        ...base.sessions,
        get: async () => hostSession(),
        readMessages: async () => ({ sessionId: SESSION_ID, messages: rows, nextCursor: null }),
      },
    });

    const loaded = await getThreadIPC(SESSION_ID);
    const durable = mapIpcMessagesToStore(loaded!.messages);
    const result = durable.find((message) => message.id === 'tool-result-row');
    const approval = durable.find((message) => message.id === 'approval-row');

    expect(result).toMatchObject({
      msgType: 'tool_result',
      tool_call_id: 'call-1',
      parentToolCallId: 'call-1',
      status: 'done',
      durationMs: 42,
    });
    expect(approval?.msgType).toBe('tool-approval');
  });

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
