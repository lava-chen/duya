import { describe, expect, it, vi } from 'vitest';
import type { HostProjectApiV1, ProjectContinuitySnapshot } from '@duya/agent-protocol/projects';
import type {
  HostProjectChannelApiV1,
  ProjectChannelBinding,
  ProjectChannelConnection,
} from '@duya/agent-protocol/project-channels';
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

function harness(options: {
  coordinator?: string | null;
  updateState?: 'ok' | 'conflict';
  channels?: Pick<HostProjectChannelApiV1, 'getProjectChannels'> & {
    sendFromCoordinator: (
      caller: { projectId: string; sessionId: string; runId: string; epoch: number },
      request: { requestId: string; channelBindingId: string; text: string; replyToInboundId?: string },
    ) => Promise<{ deliveryId: string; status: string }>;
  };
} = {}) {
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
        getTaskLinkByWorkSession: (sessionId: string) => sessionId === 'work-1' ? { project_id: PROJECT_ID, task_id: 'task-1' } : null,
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
      | 'createProjectTask'
      | 'updateProjectTask'
    >,
    ...(options.channels === undefined ? {} : { channels: options.channels }),
  });
  return { service, projectApi };
}

describe('project tool service', () => {
  it('refuses a caller that is not the bound Coordinator without touching the project', async () => {
    const { service, projectApi } = harness({ coordinator: null });

    const result = await service.dispatch({ action: 'get', payload: {}, caller: { sessionId: 'someone-else', runId: 'run-9', epoch: 1 } });

    expect(result).toEqual({ ok: false, reason: 'not_project_coordinator' });
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });

  it('resolves the project from the binding and pages activity with the requested limit', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({
      action: 'get',
      payload: { afterCursor: 2, limit: 5 },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
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
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
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
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
    });

    expect(result).toEqual({ ok: false, reason: 'revision_conflict' });
  });

  it('refuses decision acceptance and memory activation as user-only actions', async () => {
    const { service, projectApi } = harness();

    const decision = await service.dispatch({
      action: 'record_decision',
      payload: { expectedRevision: 0, key: 'k', content: 'c', status: 'accepted' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
    });
    const memory = await service.dispatch({
      action: 'record_memory',
      payload: { expectedRevision: 0, key: 'k', content: 'c', status: 'active' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
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
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
    });
    const memory = await service.dispatch({
      action: 'record_memory',
      payload: { expectedRevision: 1, key: 'style', content: 'Small modules', status: 'candidate' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
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
      caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 },
    });

    expect(projectApi.getProjectContext).toHaveBeenCalledWith(PROJECT_ID, 'task-1', 1200);
    expect(result).toMatchObject({ ok: true, context: { text: 'Durable project context' } });
  });

  it('rejects an unknown action before resolving the project', async () => {
    const { service, projectApi } = harness();

    const result = await service.dispatch({ action: 'accept_task', payload: {}, caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 } });

    expect(result).toEqual({ ok: false, reason: 'unsupported_action:accept_task' });
    expect(projectApi.getProjectContinuity).not.toHaveBeenCalled();
  });
});

describe('project tool list_channels', () => {
  const connection: ProjectChannelConnection = {
    connectionId: 'conn-1', projectId: PROJECT_ID, platform: 'discord', botUserId: 'bot-1',
    label: 'Alpha Bot', enabled: true, revision: 2, generation: 3, credentialConfigured: true,
    createdAt: 1, updatedAt: 2,
  };

  function binding(overrides: Partial<ProjectChannelBinding> = {}): ProjectChannelBinding {
    return {
      bindingId: 'binding-1', projectId: PROJECT_ID, connectionId: 'conn-1',
      guildId: 'guild-1', channelId: 'channel-1', allowedUserIds: ['member-1'],
      allowProactive: false, enabled: true, revision: 1, label: 'ops', createdAt: 1, updatedAt: 2,
      ...overrides,
    };
  }

  function withChannels(bindings: readonly ProjectChannelBinding[], activeConnection = connection) {
    const getProjectChannels = vi.fn(async () => ({
      projectId: PROJECT_ID,
      connection: activeConnection,
      bindings,
      observation: null,
      deliveries: { deliveries: [], nextCursor: null },
    }));
    return { channels: { getProjectChannels } as Pick<HostProjectChannelApiV1, 'getProjectChannels'>, getProjectChannels };
  }

  it('lists enabled bindings with the permissions the model needs, and nothing else', async () => {
    const { channels } = withChannels([
      binding(),
      binding({ bindingId: 'binding-2', label: 'releases', allowProactive: true, revision: 3 }),
      binding({ bindingId: 'binding-revoked', enabled: false }),
    ]);
    const { service } = harness({ channels });

    const result = await service.dispatch({ action: 'list_channels', payload: {}, caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 } });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      channels: [
        { bindingId: 'binding-1', label: 'ops', canReply: true, canProactive: false },
        { bindingId: 'binding-2', label: 'releases', canReply: true, canProactive: true },
      ],
    });
    // Raw platform targets never leave the Host, even though the store has them.
    expect(JSON.stringify(result)).not.toContain('channel-1');
    expect(JSON.stringify(result)).not.toContain('guild-1');
  });

  it('reports no sendable permission while the connection is disabled', async () => {
    const { channels } = withChannels([binding({ allowProactive: true })], { ...connection, enabled: false });
    const { service } = harness({ channels });

    const result = await service.dispatch({ action: 'list_channels', payload: {}, caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 } });

    expect(result).toMatchObject({
      channels: [{ bindingId: 'binding-1', canReply: false, canProactive: false }],
    });
  });

  it('refuses instead of inventing an empty list when channel support is not composed', async () => {
    const { service } = harness();

    const result = await service.dispatch({ action: 'list_channels', payload: {}, caller: { sessionId: COORDINATOR_ID, runId: 'run-1', epoch: 1 } });

    expect(result).toEqual({ ok: false, reason: 'channel_support_unavailable' });
  });

  it('still refuses callers that are not the bound Coordinator', async () => {
    const { channels, getProjectChannels } = withChannels([binding()]);
    const { service } = harness({ coordinator: null, channels });

    const result = await service.dispatch({ action: 'list_channels', payload: {}, caller: { sessionId: 'someone-else', runId: 'run-9', epoch: 1 } });

    expect(result).toEqual({ ok: false, reason: 'not_project_coordinator' });
    expect(getProjectChannels).not.toHaveBeenCalled();
  });
});

/**
 * `send_channel_message` — the Host half of the Coordinator's `send_message`.
 *
 * The model supplies a binding, text and an optional reply reference. Anything
 * that decides authorisation — project, session, run, epoch, reply scope,
 * `allowProactive` — comes from the trusted caller and the channel domain. These
 * cases pin the boundary: a payload that names an identity is refused outright,
 * and a work Session has no send path at all.
 */
describe('project tool send_channel_message', () => {
  function sendHarness(outcome: 'sent' | 'queued' | Error = 'sent') {
    const sendFromCoordinator = vi.fn(async (
      _caller: { projectId: string; sessionId: string; runId: string; epoch: number },
      _request: { requestId: string; channelBindingId: string; text: string; replyToInboundId?: string },
    ) => {
      if (outcome instanceof Error) throw outcome;
      return { deliveryId: 'delivery-1', status: outcome };
    });
    return {
      sendFromCoordinator,
      channels: { getProjectChannels: vi.fn(async () => null), sendFromCoordinator },
    };
  }

  it('forwards the Host-resolved project and the trusted attempt, not payload identity', async () => {
    const { channels, sendFromCoordinator } = sendHarness('sent');
    const { service } = harness({ channels });

    const result = await service.dispatch({
      action: 'send_channel_message',
      payload: { requestId: 'req-1', channelBindingId: 'binding-1', text: 'status is green' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
    });

    expect(result).toEqual({ ok: true, delivery: { deliveryId: 'delivery-1', status: 'sent' } });
    expect(sendFromCoordinator).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
      { requestId: 'req-1', channelBindingId: 'binding-1', text: 'status is green' },
    );
  });

  it('passes a reply reference through and omits the key when absent', async () => {
    const { channels, sendFromCoordinator } = sendHarness('sent');
    const { service } = harness({ channels });

    await service.dispatch({
      action: 'send_channel_message',
      payload: {
        requestId: 'req-2', channelBindingId: 'binding-1', text: 'hi', replyToInboundId: 'inbound-9',
      },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
    });

    expect(sendFromCoordinator).toHaveBeenCalledWith(expect.anything(), {
      requestId: 'req-2', channelBindingId: 'binding-1', text: 'hi', replyToInboundId: 'inbound-9',
    });
  });

  it('refuses a payload that tries to name its own identity or target', async () => {
    const { channels, sendFromCoordinator } = sendHarness('sent');
    const { service } = harness({ channels });

    for (const extra of [
      { actor: 'someone' },
      { projectId: 'other-project' },
      { sessionId: 'other-session' },
      { runId: 'other-run' },
      { epoch: 99 },
      { channelId: 'discord-channel' },
      { credential: 'token' },
    ]) {
      const result = await service.dispatch({
        action: 'send_channel_message',
        payload: { requestId: 'req-3', channelBindingId: 'binding-1', text: 'hi', ...extra },
        caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_send_payload' });
    }
    expect(sendFromCoordinator).not.toHaveBeenCalled();
  });

  it('gives a work Session no send path at all', async () => {
    const { channels, sendFromCoordinator } = sendHarness('sent');
    // The caller is not the project's Coordinator.
    const { service } = harness({ coordinator: null, channels });

    const result = await service.dispatch({
      action: 'send_channel_message',
      payload: { requestId: 'req-4', channelBindingId: 'binding-1', text: 'hi' },
      caller: { sessionId: 'work-session', runId: 'run-8', epoch: 1 },
    });

    expect(result).toEqual({ ok: false, reason: 'not_project_coordinator' });
    expect(sendFromCoordinator).not.toHaveBeenCalled();
  });

  it('reports the domain refusal verbatim instead of inventing a delivery', async () => {
    const { channels } = sendHarness(Object.assign(new Error('scope'), { code: 'reply_scope_invalid' }));
    const { service } = harness({ channels });

    const result = await service.dispatch({
      action: 'send_channel_message',
      payload: { requestId: 'req-5', channelBindingId: 'binding-1', text: 'hi', replyToInboundId: 'inbound-1' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
    });

    expect(result).toEqual({ ok: false, reason: 'reply_scope_invalid' });
  });

  it('keeps the ledger status instead of upgrading queued to sent', async () => {
    const { channels } = sendHarness('queued');
    const { service } = harness({ channels });

    const result = await service.dispatch({
      action: 'send_channel_message',
      payload: { requestId: 'req-6', channelBindingId: 'binding-1', text: 'hi' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
    });

    expect(result).toEqual({ ok: true, delivery: { deliveryId: 'delivery-1', status: 'queued' } });
  });

  it('refuses when channel support is not composed rather than dropping the message', async () => {
    const { service } = harness();

    const result = await service.dispatch({
      action: 'send_channel_message',
      payload: { requestId: 'req-7', channelBindingId: 'binding-1', text: 'hi' },
      caller: { sessionId: COORDINATOR_ID, runId: 'run-7', epoch: 3 },
    });

    expect(result).toEqual({ ok: false, reason: 'channel_support_unavailable' });
  });
});
