import { describe, expect, it, vi } from 'vitest';
import type { HostMailboxEnqueueInput, HostMailboxItem } from '@duya/agent-protocol/mailbox';
import { createHostSessionInputService } from '../src/session-input-service.js';
import type { SessionServiceCaller } from '../src/session-service.js';

const caller: SessionServiceCaller = { sessionId: 'caller-session', runId: 'caller-run', epoch: 1 };

function makeService(workspace: { state: 'bound'; workspaceId: string } | { state: 'legacy_unbound' }) {
  const list = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
  const get = vi.fn().mockResolvedValue({
    id: caller.sessionId,
    status: 'active',
    workspace,
    parentSessionId: null,
    extensions: {},
  });
  const service = createHostSessionInputService({
    sessions: { get, list, update: vi.fn() } as never,
    runs: {} as never,
    mailbox: {} as never,
    validateCaller: vi.fn(),
  });
  return { service, list, get };
}

function makeInputService(options: {
  readonly callerWorkspace?: string;
  readonly targetWorkspace?: string;
  readonly lease?: Record<string, unknown>;
} = {}) {
  const callerSession = {
    id: caller.sessionId,
    status: 'active',
    workspace: options.callerWorkspace
      ? { state: 'bound' as const, workspaceId: options.callerWorkspace }
      : { state: 'legacy_unbound' as const },
    parentSessionId: null,
    extensions: {},
  };
  const targetSession = {
    id: 'target-session',
    status: 'active',
    workspace: options.targetWorkspace
      ? { state: 'bound' as const, workspaceId: options.targetWorkspace }
      : { state: 'legacy_unbound' as const },
    parentSessionId: null,
    extensions: options.lease ? { 'host.sessionControlLease': options.lease } : {},
  };
  const sessions = new Map([
    [callerSession.id, callerSession],
    [targetSession.id, targetSession],
  ]);
  const get = vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null);
  const list = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
  const update = vi.fn();
  const runs = {
    listAgentRunsBySession: vi.fn().mockResolvedValue([{ runId: 'target-run', status: 'running' }]),
    readAgentRunEvents: vi.fn().mockResolvedValue([
      { seq: 1, payload: { type: 'turn.started', turnId: 'target-turn' } },
    ]),
  };
  const items = new Map<string, HostMailboxItem>();
  const enqueue = vi.fn(async (input: HostMailboxEnqueueInput) => {
    const item: HostMailboxItem = {
      ...input,
      status: 'pending',
      priority: 0,
      attachments: input.attachments ?? null,
      source: input.source ?? 'user',
      clientMsgId: input.clientMsgId ?? null,
      claimToken: null,
      claimExpiresAt: null,
      claimAttempts: 0,
      lastClaimError: null,
      observedAt: null,
      observedAtCheckpoint: null,
      observedByRunId: null,
      injectedRunId: null,
      applyMode: null,
      appliedAt: null,
      appliedAtCheckpoint: null,
      appliedSummary: null,
      resultingEventId: null,
      editLockedAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      meta: input.meta ?? {},
      createdAt: 1,
    };
    items.set(item.id, item);
    return item;
  });
  const getByClientMsgId = vi.fn(async (sessionId: string, requestId: string) =>
    [...items.values()].find((item) => item.sessionId === sessionId && item.clientMsgId === requestId) ?? null);
  const getItem = vi.fn(async (inputId: string) => items.get(inputId) ?? null);
  const validateCaller = vi.fn();
  const service = createHostSessionInputService({
    sessions: { get, list, update } as never,
    runs: runs as never,
    mailbox: { enqueue, getByClientMsgId, getItem } as never,
    validateCaller,
  });
  return { service, sessions, runs, enqueue, getByClientMsgId, getItem, items };
}

describe('Host Session list scope', () => {
  it('derives workspace listing from the authenticated caller and includes archived sessions only when requested', async () => {
    const { service, list, get } = makeService({ state: 'bound', workspaceId: 'workspace-1' });

    await service.listAccessibleSessions({ scope: 'workspace', includeArchived: true, limit: 10, cursor: 'cursor-1' }, caller);

    expect(get).toHaveBeenCalledWith(caller.sessionId, { includeAllSessions: true });
    expect(list).toHaveBeenCalledWith({
      includeAllSessions: true,
      includeArchived: true,
      limit: 10,
      cursor: 'cursor-1',
      workspaceId: 'workspace-1',
    });
  });

  it('limits legacy unbound sessions to direct children and refuses workspace-wide listing', async () => {
    const { service, list } = makeService({ state: 'legacy_unbound' });

    await service.listAccessibleSessions({ scope: 'children', includeArchived: false, limit: 5 }, caller);
    await expect(service.listAccessibleSessions({ scope: 'workspace', includeArchived: false, limit: 5 }, caller))
      .rejects.toThrow('session_workspace_unavailable');

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      includeAllSessions: true,
      includeArchived: false,
      limit: 5,
      parentSessionId: caller.sessionId,
    });
  });
});

describe('Host Session input receipts', () => {
  it('persists an async steer with a Host-derived actor and returns the original receipt on retry', async () => {
    const { service, enqueue } = makeInputService({ callerWorkspace: 'workspace-1', targetWorkspace: 'workspace-1' });
    const request = {
      sessionId: 'target-session',
      requestId: 'request-1',
      intent: 'steer' as const,
      content: 'Please inspect the change.',
    };

    const first = await service.submitInput(request, caller);
    const retry = await service.submitInput(request, caller);

    expect(first).toMatchObject({
      requestId: 'request-1',
      sessionId: 'target-session',
      actor: { kind: 'bot', id: caller.sessionId },
      stage: 'persisted',
    });
    expect(retry.inputId).toBe(first.inputId);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'target-session',
      submittedRunId: caller.runId,
      kind: 'followup',
      source: `session_input:bot:${caller.sessionId}`,
      meta: { sessionInput: { expectedRunId: 'target-run', expectedTurnId: 'target-turn' } },
    });
  });

  it('rejects reuse of a request id with different content and refuses cross-workspace targets', async () => {
    const sameWorkspace = makeInputService({ callerWorkspace: 'workspace-1', targetWorkspace: 'workspace-1' });
    const request = {
      sessionId: 'target-session',
      requestId: 'request-2',
      intent: 'enqueue' as const,
      content: 'First message',
    };
    await sameWorkspace.service.submitInput(request, caller);
    const conflict = await sameWorkspace.service.submitInput({ ...request, content: 'Changed message' }, caller);
    expect(conflict).toMatchObject({ stage: 'rejected', reason: 'request_id_conflict' });
    expect(sameWorkspace.enqueue).toHaveBeenCalledTimes(1);

    const differentWorkspace = makeInputService({ callerWorkspace: 'workspace-1', targetWorkspace: 'workspace-2' });
    const denied = await differentWorkspace.service.submitInput({ ...request, requestId: 'request-3' }, caller);
    expect(denied).toMatchObject({ stage: 'rejected', reason: 'session_not_accessible' });
    expect(differentWorkspace.enqueue).not.toHaveBeenCalled();
  });

  it('rejects delivery when the control lease changes after the input was persisted', async () => {
    const lease = {
      sessionId: 'target-session',
      leaseId: 'lease-1',
      holder: { kind: 'bot', id: caller.sessionId },
      revision: 1,
      requestId: 'lease-request-1',
      expiresAt: Date.now() + 60_000,
    };
    const { service, sessions, enqueue, getItem } = makeInputService({
      callerWorkspace: 'workspace-1',
      targetWorkspace: 'workspace-1',
      lease,
    });
    const receipt = await service.submitInput({
      sessionId: 'target-session',
      requestId: 'request-4',
      intent: 'steer',
      content: 'Continue under my lease.',
      controlRevision: 1,
    }, caller);
    expect(receipt.stage).toBe('persisted');
    expect(enqueue).toHaveBeenCalledTimes(1);

    sessions.set('target-session', {
      ...sessions.get('target-session')!,
      extensions: {
        'host.sessionControlLease': { ...lease, leaseId: 'lease-2', revision: 2, requestId: 'lease-request-2' },
      },
    });
    const reason = await service.validateInputDelivery({
      inputId: receipt.inputId,
      sessionId: 'target-session',
      runId: 'target-run',
      turnId: 'target-turn',
    }, { sessionId: 'target-session', runId: 'target-run', epoch: 2 });

    expect(getItem).toHaveBeenCalledWith(receipt.inputId);
    expect(reason).toBe('control_lease_changed');
  });
});
