import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentRunRecord,
  HostRunApiV1,
  HostRunExecutionApiV1,
  RunEventEnvelope,
} from '@duya/agent-protocol';
import type {
  HostSessionApiV1,
  HostSessionCreateInput,
  HostSessionRecord,
  HostSessionUpdateResult,
} from '@duya/agent-protocol/session-api';
import type { CoreSession } from '@duya/data/session-store';
import { createHostSessionService, type SessionServiceCaller } from '../src/session-service.js';
import { createProjectDispatchPort } from '../src/project/dispatch.js';
import { projectTaskFixture } from './project-task-fixture.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Harness {
  service: ReturnType<typeof createHostSessionService>;
  projectFixture?: ReturnType<typeof projectTaskFixture>;
  caller: SessionServiceCaller;
  workingDirectory: string;
  parent: HostSessionRecord;
  childRecords: Map<string, HostSessionRecord>;
  runRecords: Map<string, AgentRunRecord>;
  runEvents: Map<string, readonly RunEventEnvelope[]>;
  starts: string[];
  cancellations: string[];
  deferredStartEntered: Promise<void>;
  releaseDeferredStart(): void;
  setRunStatus(runId: string, status: AgentRunRecord['status']): void;
  setRunEvents(runId: string, events: readonly RunEventEnvelope[]): void;
  getRunEventReadCount(runId: string): number;
}

async function createHarness(options: {
  readonly refusePrompt?: string;
  readonly forgedCaller?: boolean;
  readonly expireAfterParentLookup?: boolean;
  readonly expireDuringCreate?: boolean;
  readonly deferStartPrompt?: string;
  readonly throwRunningIdentityUpdate?: boolean;
  readonly project?: boolean;
  readonly createFailure?: boolean;
  readonly checkoutFailure?: boolean;
  readonly loseStartReceipt?: boolean;
  readonly replaceCoordinatorDuringCreate?: boolean;
  readonly replaceCoordinatorDuringCheckout?: boolean;
} = {}): Promise<Harness> {
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-session-service-'));
  tempRoots.push(workingDirectory);
  const parent: HostSessionRecord = {
    id: 'parent-session',
    workspace: {
      state: 'bound',
      workspaceId: 'workspace-1',
      rootId: 'root-1',
      relativePath: '',
    },
    title: 'Parent',
    projectName: 'Project',
    status: 'active',
    model: 'parent-model',
    providerId: 'parent-provider',
    mode: 'chat',
    permissionMode: 'auto',
    agentProfileId: options.project ? 'project-coordinator' : 'profile-1',
    parentSessionId: null,
    agentType: 'chat',
    agentName: '',
    draft: null,
    extensions: {},
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    lastTurnStartedAt: null,
  };
  const projectFixture = options.project ? projectTaskFixture(parent.id) : undefined;
  const otherParent: HostSessionRecord = { ...parent, id: 'other-parent' };
  const childRecords = new Map<string, HostSessionRecord>();
  const runRecords = new Map<string, AgentRunRecord>();
  const runEvents = new Map<string, readonly RunEventEnvelope[]>();
  const runEventReadCounts = new Map<string, number>();
  const starts: string[] = [];
  const cancellations: string[] = [];
  let attemptExpired = false;
  let releaseDeferredStart!: () => void;
  let signalDeferredStartEntered!: () => void;
  const deferredStart = new Promise<void>((resolve) => { releaseDeferredStart = resolve; });
  const deferredStartEntered = new Promise<void>((resolve) => { signalDeferredStartEntered = resolve; });
  let nextSession = 0;
  let nextRun = 0;

  const sessions = {
    async get(sessionId: string, getOptions?: { includeAllSessions?: boolean }) {
      const record = sessionId === parent.id ? parent : sessionId === otherParent.id ? otherParent : childRecords.get(sessionId) ?? null;
      if (record?.parentSessionId && getOptions?.includeAllSessions !== true) return null;
      if (options.expireAfterParentLookup && sessionId === parent.id) attemptExpired = true;
      return record;
    },
    async create(input: HostSessionCreateInput) {
      if (options.createFailure) throw new Error('session create failed');
      const id = `child-${++nextSession}`;
      const record: HostSessionRecord = {
        ...parent,
        id,
        workspace: input.workspaceId === undefined
          ? { state: 'legacy_unbound' }
          : {
              state: 'bound',
              workspaceId: input.workspaceId,
              rootId: input.workspaceRootId ?? null,
              relativePath: input.workspaceRelativePath ?? '',
            },
        title: input.title ?? '',
        model: input.model ?? parent.model,
        providerId: parent.providerId,
        permissionMode: input.permissionMode ?? parent.permissionMode,
        agentProfileId: input.agentProfileId ?? parent.agentProfileId,
        parentSessionId: input.parentSessionId ?? null,
        agentType: input.agentType ?? 'session-spawn',
        extensions: input.extensions ?? {},
      };
      childRecords.set(id, record);
      if (options.expireDuringCreate) attemptExpired = true;
      if (options.replaceCoordinatorDuringCreate) projectFixture!.projects.bindCoordinatorSession(projectFixture!.projectId, 'replacement');
      return record;
    },
    async list(query?: { parentSessionId?: string; cursor?: string; limit?: number }) {
      const records = [...childRecords.values()]
        .filter((record) => query?.parentSessionId === undefined || record.parentSessionId === query.parentSessionId)
        .map((session) => ({ session, timelineCount: 0 }));
      const offset = Number(query?.cursor ?? 0);
      const limit = query?.limit ?? 50;
      const nextOffset = offset + limit;
      return {
        sessions: records.slice(offset, nextOffset),
        nextCursor: nextOffset < records.length ? String(nextOffset) : null,
      };
    },
    async update(sessionId: string, _expectedUpdatedAt: number | undefined, patch: { extensions?: Record<string, unknown>; title?: string; status?: string }): Promise<HostSessionUpdateResult> {
      const record = childRecords.get(sessionId);
      if (!record) return { updated: false, reason: 'not_found' };
      const spawnMetadata = patch.extensions?.['host.sessionSpawn'];
      if (options.throwRunningIdentityUpdate && typeof spawnMetadata === 'object' && spawnMetadata !== null
          && 'status' in spawnMetadata && spawnMetadata.status === 'running') {
        throw new Error('identity persistence unavailable');
      }
      childRecords.set(sessionId, {
        ...record,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.extensions === undefined ? {} : { extensions: { ...record.extensions, ...patch.extensions } }),
      });
      return { updated: true, session: childRecords.get(sessionId)! };
    },
    async getSessionChangeStats() {
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    },
  } as unknown as Pick<HostSessionApiV1, 'get' | 'create' | 'list' | 'update' | 'getSessionChangeStats'>;

  const runs = {
    async getAgentRun(runId: string) {
      return runRecords.get(runId) ?? null;
    },
    async listAgentRunsBySession(sessionId: string) {
      return [...runRecords.values()].filter((run) => run.sessionId === sessionId);
    },
    async readAgentRunEvents(runId: string, query?: { afterSeq?: number; limit?: number }) {
      runEventReadCounts.set(runId, (runEventReadCounts.get(runId) ?? 0) + 1);
      return (runEvents.get(runId) ?? [])
        .filter((event) => event.seq > (query?.afterSeq ?? 0))
        .slice(0, query?.limit ?? 500);
    },
  } as unknown as Pick<HostRunApiV1, 'getAgentRun' | 'listAgentRunsBySession' | 'readAgentRunEvents'>;

  const execution = {
    async startAgentRun(input: { sessionId: string; prompt: string }) {
      starts.push(input.prompt);
      if (options.deferStartPrompt === input.prompt) {
        signalDeferredStartEntered();
        await deferredStart;
      }
      if (options.refusePrompt === input.prompt) {
        return { accepted: false, stage: 'refused_dispatch_failed', reason: 'worker unavailable' } as const;
      }
      const runId = `run-${++nextRun}`;
      const child = childRecords.get(input.sessionId);
      if (!child) return { accepted: false, stage: 'refused_no_session', reason: 'missing child' } as const;
      runRecords.set(runId, {
        runId,
        sessionId: input.sessionId,
        status: 'running',
        terminal: null,
        metrics: null,
        origin: null,
        parentRunId: null,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        manifest: {} as AgentRunRecord['manifest'],
        manifestHash: 'test-hash',
        inputHash: null,
      });
      runEvents.set(runId, [{
        runId,
        sessionId: input.sessionId,
        seq: 1,
        timestamp: Date.now(),
        traceId: runId,
        payload: { type: 'assistant.text_block', messageId: `${runId}:message`, index: 0, text: `result:${input.prompt}` },
      } as RunEventEnvelope]);
      if (options.loseStartReceipt) throw new Error('start response lost');
      return { accepted: true, stage: 'dispatched', runId } as const;
    },
    async cancelAgentRun(runId: string) {
      cancellations.push(runId);
      const record = runRecords.get(runId);
      if (record) runRecords.set(runId, { ...record, status: 'cancelled' });
      return { requested: true, runId } as const;
    },
  } as unknown as Pick<HostRunExecutionApiV1, 'startAgentRun' | 'cancelAgentRun'>;

  const caller: SessionServiceCaller = { sessionId: parent.id, runId: 'parent-run', epoch: 7 };
  const service = createHostSessionService({
    ...(projectFixture ? { projectDispatch: createProjectDispatchPort(projectFixture.stores) } : {}),
    ...(options.checkoutFailure || options.replaceCoordinatorDuringCheckout ? { checkoutService: {
      read: () => ({ checkout: null }),
      createChildCheckout: async () => {
        if (options.checkoutFailure) throw new Error('checkout failed');
        projectFixture!.projects.bindCoordinatorSession(projectFixture!.projectId, 'replacement');
        return { state: { cwd: workingDirectory, checkout: null } };
      },
    } as never } : {}),
    sessions,
    runs,
    execution,
    readLocalSession: async (id) => id === parent.id || id === otherParent.id || childRecords.has(id)
      ? ({ id, workingDirectory, extensions: {} } as CoreSession)
      : null,
    validateCaller: (value) => {
      const parentAttempt = value.sessionId === caller.sessionId && value.runId === caller.runId && value.epoch === caller.epoch;
      const otherAttempt = value.sessionId === otherParent.id && value.runId === 'other-parent-run' && value.epoch === 4;
      if (attemptExpired || (!parentAttempt && !otherAttempt)) {
        throw new Error('caller attempt is not current');
      }
      if (options.forgedCaller) throw new Error('caller attempt is not current');
    },
  });
  return {
    service,
    ...(projectFixture ? { projectFixture } : {}),
    caller,
    workingDirectory,
    parent,
    childRecords,
    runRecords,
    runEvents,
    starts,
    cancellations,
    deferredStartEntered,
    releaseDeferredStart,
    setRunStatus(runId, status) {
      const record = runRecords.get(runId);
      if (record) runRecords.set(runId, { ...record, status });
    },
    setRunEvents(runId, events) {
      runEvents.set(runId, events);
    },
    getRunEventReadCount(runId) {
      return runEventReadCounts.get(runId) ?? 0;
    },
  };
}

describe('Project launch failure reconciliation through Session service', () => {
  async function prepare(options: Parameters<typeof createHarness>[0] = {}) {
    const h = await createHarness({ ...options, project: true });
    const f = h.projectFixture!;
    const taskId = f.lifecycle.create({ projectId: f.projectId, coordinatorSessionId: h.parent.id,
      requestId: 'create', subject: 'Ship feature', description: 'Implement and test feature' });
    function spawn(prompt = 'work') {
      return h.service.dispatch('session:spawn', { prompt, workingDirectory: h.workingDirectory, use_worktree: false,
        projectTask: { taskId, expectedRevision: f.projects.getTaskLink(taskId)!.revision! } }, h.caller);
    }
    return { ...h, f, taskId, spawn };
  }
  it.each([
    ['Session creation', { createFailure: true }, 'session create failed'],
    ['checkout setup', { checkoutFailure: true }, 'checkout failed'],
    ['Run admission', { refusePrompt: 'work' }, 'worker unavailable'],
    ['expired caller', { expireDuringCreate: true }, 'caller_attempt_not_current'],
    ['replaced Coordinator', { replaceCoordinatorDuringCreate: true }, 'not_project_coordinator'],
    ['Coordinator replaced during checkout', { replaceCoordinatorDuringCheckout: true }, 'not_current_project_work'],
  ] as const)('records a failed attempt after %s, leaving canonical Task pending', async (_name, options, reason) => {
    const h = await prepare(options);
    expect(await h.spawn()).toMatchObject({ ok: false, taskId: h.taskId, reason: expect.stringContaining(reason) });
    expect(h.f.projects.listTaskAttempts(h.taskId)[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining(reason) });
    expect(h.f.tasks.get(h.taskId)?.status).toBe('pending');
    expect(h.f.projects.getTaskLink(h.taskId)?.acceptance_status).toBe('pending');
    if (h.childRecords.size) expect(h.childRecords.get('child-1')?.status).toBe('error');
  });
  it('cancels a launch accepted after Coordinator authority changed and keeps an unknown receipt', async () => {
    const h = await prepare({ deferStartPrompt: 'work' });
    const pending = h.spawn();
    await h.deferredStartEntered;
    h.f.projects.bindCoordinatorSession(h.f.projectId, 'replacement');
    h.releaseDeferredStart();
    expect(await pending).toMatchObject({ ok: false, taskId: h.taskId, reason: 'not_current_project_work' });
    expect(h.cancellations).toEqual(['run-1']);
    expect(h.f.projects.listTaskAttempts(h.taskId)[0]).toMatchObject({ status: 'unknown', run_id: 'run-1' });
    expect(await h.service.dispatch('session:spawnRename', { sessionId: 'child-1', title: 'Stale parent' }, h.caller))
      .toMatchObject({ ok: false, reason: 'not_found_or_not_owned' });
  });

  it('retries the same Task after a known admission failure and rejects concurrent duplicate launches', async () => {
    const h = await prepare({ refusePrompt: 'bad', deferStartPrompt: 'retry' });
    expect(await h.spawn('bad')).toMatchObject({ ok: false, taskId: h.taskId });
    const retry = h.spawn('retry');
    await h.deferredStartEntered;
    expect(await h.spawn('duplicate')).toMatchObject({ ok: false, reason: expect.stringContaining('task_execution_active') });
    h.releaseDeferredStart();
    expect(await retry).toMatchObject({ ok: true, taskId: h.taskId, runId: 'run-1' });
    expect(h.f.projects.listTaskAttempts(h.taskId)).toHaveLength(2);
    expect(h.f.tasks.getBySession(h.parent.id)).toHaveLength(1);
  });
  it('keeps a lost Run-start response unknown and blocks retry until durable Run reconciliation', async () => {
    const h = await prepare({ loseStartReceipt: true });
    expect(await h.spawn()).toMatchObject({ ok: false, taskId: h.taskId });
    expect(h.f.projects.listTaskAttempts(h.taskId)[0]?.status).toBe('unknown');
    expect(await h.spawn()).toMatchObject({ ok: false, reason: expect.stringContaining('task_execution_active') });
    h.f.lifecycle.recover((sessionId) => [...h.runRecords.values()].filter((run) => run.sessionId === sessionId)
      .map((run) => ({ id: run.runId, status: run.status, terminal: run.terminal, created_at: run.createdAt })));
    expect(h.f.projects.listTaskAttempts(h.taskId)[0]).toMatchObject({ status: 'running', run_id: 'run-1' });
    expect(h.starts).toHaveLength(1);
  });
});

describe('Host session service', () => {
  it('spawns two independent child sessions and reads each result from its durable run', async () => {
    const harness = await createHarness();
    const first = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'first child task',
      model: 'child-model',
    }, harness.caller);
    const second = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'second child task',
    }, harness.caller);

    expect(first).toMatchObject({ ok: true, parentId: harness.parent.id, sessionId: 'child-1', runId: 'run-1', completionNotification: 'query' });
    expect(second).toMatchObject({ ok: true, parentId: harness.parent.id, sessionId: 'child-2', runId: 'run-2', completionNotification: 'query' });
    expect(harness.childRecords.get('child-1')).toMatchObject({
      workspace: harness.parent.workspace,
      model: 'child-model',
      providerId: harness.parent.providerId,
      permissionMode: harness.parent.permissionMode,
      agentProfileId: harness.parent.agentProfileId,
    });
    expect(harness.childRecords.get('child-2')?.model).toBe(harness.parent.model);
    const list = await harness.service.dispatch('session:spawnList', {}, harness.caller);
    expect(list).toMatchObject({ ok: true, sessions: [{ id: 'child-1' }, { id: 'child-2' }] });
    harness.setRunStatus('run-1', 'completed');
    harness.setRunStatus('run-2', 'completed');
    const firstResult = await harness.service.dispatch('session:spawnGet', { sessionId: 'child-1' }, harness.caller);
    const secondResult = await harness.service.dispatch('session:spawnGet', { sessionId: 'child-2' }, harness.caller);
    expect(firstResult).toMatchObject({ ok: true, runId: 'run-1', runStatus: 'completed', output: 'result:first child task' });
    expect(secondResult).toMatchObject({ ok: true, runId: 'run-2', runStatus: 'completed', output: 'result:second child task' });
    expect(firstResult).toMatchObject({ session: { runId: 'run-1', output: 'result:first child task' } });
    expect(secondResult).toMatchObject({ session: { runId: 'run-2', output: 'result:second child task' } });
  });

  it('rejects cross-parent access and a caller whose run/epoch is not current', async () => {
    const harness = await createHarness();
    const child = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'owned child',
    }, harness.caller);
    const result = await harness.service.dispatch('session:spawnGet', { sessionId: 'child-1' }, {
      ...harness.caller,
      sessionId: 'other-parent',
      runId: 'other-parent-run',
      epoch: 4,
    });
    const forgedHarness = await createHarness({ forgedCaller: true });
    const forged = await forgedHarness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'must not start',
    }, forgedHarness.caller);

    expect(child).toMatchObject({ ok: true });
    expect(result).toMatchObject({ ok: false });
    expect(forged).toMatchObject({ ok: false });
    expect(forgedHarness.starts).toEqual([]);
  });

  it('refuses workspace escape, rejects reply while running, and cancels only the captured run', async () => {
    const harness = await createHarness();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-session-service-outside-'));
    tempRoots.push(outside);
    const escape = await harness.service.dispatch('session:spawn', {
      workingDirectory: outside,
      prompt: 'escape attempt',
    }, harness.caller);
    const child = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'live child',
    }, harness.caller);
    const reply = await harness.service.dispatch('session:spawnReply', {
      sessionId: 'child-1',
      prompt: 'too soon',
    }, harness.caller);
    const cancel = await harness.service.dispatch('session:spawnCancel', { sessionId: 'child-1' }, harness.caller);
    const completedRunId = String((child as { runId?: string }).runId ?? '');
    harness.setRunStatus(completedRunId, 'completed');
    await harness.service.dispatch('session:spawnReply', {
      sessionId: 'child-1',
      prompt: 'follow-up',
    }, harness.caller);

    expect(escape).toMatchObject({ ok: false });
    expect(harness.childRecords.size).toBe(1);
    expect(reply).toMatchObject({ ok: false });
    expect(cancel).toMatchObject({ ok: true, runId: completedRunId });
    expect(harness.cancellations).toEqual([completedRunId]);
  });

  it('leaves visible failed metadata when Host refuses to start a child run', async () => {
    const harness = await createHarness({ refusePrompt: 'refused child' });
    const result = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'refused child',
    }, harness.caller);

    expect(result).toMatchObject({ ok: false, sessionId: 'child-1' });
    expect(harness.childRecords.get('child-1')?.extensions).toMatchObject({
      'host.sessionSpawn': { status: 'failed' },
    });
  });

  it('cancels an accepted run and records failure when child run identity persistence throws', async () => {
    const harness = await createHarness({ throwRunningIdentityUpdate: true });

    const result = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'identity persistence failure',
    }, harness.caller);

    expect(result).toMatchObject({
      ok: false,
      sessionId: 'child-1',
      reason: expect.stringContaining('run_started_but_child_run_identity_was_not_persisted'),
    });
    expect(harness.cancellations).toEqual(['run-1']);
    expect(harness.runRecords.get('run-1')?.status).toBe('cancelled');
    expect(harness.childRecords.get('child-1')).toMatchObject({
      status: 'error',
      extensions: {
        'host.sessionSpawn': {
          status: 'failed',
          failureReason: expect.stringContaining('run_started_but_child_run_identity_was_not_persisted'),
        },
      },
    });
  });

  it('serializes concurrent replies for one child before checking and starting the next run', async () => {
    const harness = await createHarness({ deferStartPrompt: 'first follow-up' });
    await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'initial child task',
    }, harness.caller);
    harness.setRunStatus('run-1', 'completed');

    const firstReply = harness.service.dispatch('session:spawnReply', {
      sessionId: 'child-1',
      prompt: 'first follow-up',
    }, harness.caller);
    await harness.deferredStartEntered;
    const secondReply = harness.service.dispatch('session:spawnReply', {
      sessionId: 'child-1',
      prompt: 'second follow-up',
    }, harness.caller);
    harness.releaseDeferredStart();
    const [first, second] = await Promise.all([firstReply, secondReply]);

    expect(first).toMatchObject({ ok: true, runId: 'run-2', completionNotification: 'query' });
    expect(second).toMatchObject({ ok: false, reason: 'run_in_progress' });
    expect(harness.starts).toEqual(['initial child task', 'first follow-up']);
  });

  it('revalidates the caller after the parent lookup before creating or launching a child', async () => {
    const harness = await createHarness({ expireAfterParentLookup: true });
    const result = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'stale attempt task',
    }, harness.caller);

    expect(result).toMatchObject({ ok: false });
    expect(harness.childRecords.size).toBe(0);
    expect(harness.starts).toEqual([]);
  });

  it('marks only the newly created child failed when the caller expires during creation', async () => {
    const harness = await createHarness({ expireDuringCreate: true });

    const result = await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'expire during child create',
    }, harness.caller);

    expect(result).toMatchObject({
      ok: false,
      sessionId: 'child-1',
      parentId: harness.parent.id,
      reason: 'caller_attempt_not_current',
    });
    expect(harness.starts).toEqual([]);
    expect(harness.childRecords.get('child-1')).toMatchObject({
      status: 'error',
      extensions: {
        'host.sessionSpawn': {
          status: 'failed',
          failureReason: 'caller_attempt_not_current',
        },
      },
    });
  });

  it('lists direct children across the Host session API default page boundary', async () => {
    const harness = await createHarness();
    for (let index = 1; index <= 51; index += 1) {
      const id = `child-${index}`;
      harness.childRecords.set(id, {
        ...harness.parent,
        id,
        title: `Child ${index}`,
        parentSessionId: harness.parent.id,
        extensions: { 'host.sessionSpawn': { status: 'completed' } },
      });
    }

    const result = await harness.service.dispatch('session:spawnList', {}, harness.caller);

    expect(result).toMatchObject({ ok: true });
    expect((result as { sessions: unknown[] }).sessions).toHaveLength(51);
    expect((result as { sessions: Array<{ id: string }> }).sessions.at(-1)?.id).toBe('child-51');
  });

  it('pages durable run events past the 500-event Host API limit', async () => {
    const harness = await createHarness();
    await harness.service.dispatch('session:spawn', {
      workingDirectory: harness.workingDirectory,
      prompt: 'long result task',
    }, harness.caller);
    harness.setRunStatus('run-1', 'completed');
    harness.setRunEvents('run-1', Array.from({ length: 501 }, (_, index) => ({
      runId: 'run-1',
      sessionId: 'child-1',
      seq: index + 1,
      timestamp: index + 1,
      traceId: 'run-1',
      payload: {
        type: 'assistant.text_block',
        messageId: `message-${index + 1}`,
        index,
        text: 'x',
      },
    } as RunEventEnvelope)));

    const result = await harness.service.dispatch('session:spawnGet', { sessionId: 'child-1' }, harness.caller);

    expect(result).toMatchObject({ ok: true, runId: 'run-1', output: 'x'.repeat(501) });
    expect(harness.getRunEventReadCount('run-1')).toBe(2);
  });
});
