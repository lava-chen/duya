/**
 * A `HostApiBridge` that answers from memory.
 *
 * ## Why a bridge and not a `UiServices`
 *
 * The shared renderer reaches the Host through ONE seam: the `HostApiBridge`
 * port, composed into a `UiServices` by the shared factory. A surface that
 * wrote its own `UiServices` would re-implement the plumbing that the Web
 * and the Desktop share — and the mock would then be testing a second
 * composition instead of the real one.
 *
 * So the mock supplies a bridge and lets `createUiServices` do the rest. Every
 * line of plumbing between the renderer and a run (cancellation, approvals,
 * the ledger poll, the run projection) is the PRODUCT's code.
 *
 * ## What the bridge fakes
 *
 * The durable state: sessions, transcripts, the run ledger, approvals. The
 * run's EVENTS are a hand-written script, delivered a few envelopes at a time
 * so the chat streams the way it does in the product.
 */

import type {
  AgentRunRecord,
  CancelAgentRunResult,
  HostMessagePage,
  HostMessageReadAllQuery,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestResolveInput,
  HostProviderCatalog,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListItem,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  RunEventEnvelope,
  RunId,
  SessionId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type { HostApiBridge } from '@duya/client-core';
import {
  buildMockManifest,
  MOCK_EPOCH,
  MOCK_PENDING_APPROVAL,
  MOCK_PROVIDER_CATALOG,
  MOCK_RUNS,
  MOCK_THREADS,
  type MockRunFixture,
} from './fixtures';

interface MockRunState {
  readonly fixture: MockRunFixture;
  /** The highest seq the client has been served. */
  deliveredSeq: number;
  settled: boolean;
  /**
   * Events appended AFTER the fixture script was written.
   *
   * A real Host answers a permission by publishing `permission.resolved` on
   * the run's own event stream — that is how the renderer's projection learns
   * the card may close. The mock does the same, so the approval card really
   * resolves instead of only changing a ledger row the renderer never reads.
   */
  readonly extraEvents: RunEventEnvelope[];
}

export interface MockHostBridge extends HostApiBridge {
  /** Test hook: the run records the bridge currently holds. */
  readonly debugRuns: () => readonly AgentRunRecord[];
}

/** How many envelopes one durable-window read serves. */
const EVENTS_PER_READ = 3;

function toSessionRecord(thread: (typeof MOCK_THREADS)[number]): HostSessionRecord {
  return {
    id: thread.id,
    workspace: {
      state: 'bound',
      workspaceId: `ws-${thread.projectName ?? 'none'}`,
      rootId: null,
      relativePath: thread.workingDirectory ?? '',
    },
    title: thread.title,
    projectName: thread.projectName ?? '',
    status: 'idle',
    model: thread.model ?? 'mock-model',
    providerId: thread.providerId ?? 'mock-provider',
    mode: 'default',
    permissionMode: 'default',
    agentProfileId: null,
    parentSessionId: null,
    agentType: 'main',
    agentName: '独雅',
    draft: null,
    extensions: {},
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt ?? thread.updatedAt,
    lastTurnStartedAt: thread.lastTurnStartedAt ?? null,
  };
}

/**
 * Build the mock bridge.
 *
 * Every method is synchronous in spirit: it answers from the fixtures, with
 * no IO and no timing, so a mock render never waits on anything.
 */
export function createMockHostBridge(): MockHostBridge {
  const sessions = new Map<SessionId, HostSessionRecord>(
    MOCK_THREADS.map((thread) => [thread.id, toSessionRecord(thread)]),
  );
  const runs = new Map<RunId, MockRunState>();
  for (const fixture of MOCK_RUNS) {
    runs.set(fixture.runId, { fixture, deliveredSeq: 0, settled: false, extraEvents: [] });
  }
  const approvals = new Map<string, HostPermissionRequest>();
  if (MOCK_PENDING_APPROVAL.status === 'pending') {
    approvals.set(MOCK_PENDING_APPROVAL.id, MOCK_PENDING_APPROVAL);
  }

  const toRunRecord = (state: MockRunState): AgentRunRecord => {
    const { fixture } = state;
    const total = fixture.events.length + state.extraEvents.length;
    const drained = state.deliveredSeq >= total;
    // A run that awaits an answer stays open until it gets one. Once the
    // answer is in, the run may settle like any other.
    const status = drained && (state.settled || !fixture.open) ? 'completed' : 'running';
    return {
      runId: fixture.runId,
      sessionId: fixture.sessionId,
      manifest: buildMockManifest(fixture.runId, fixture.sessionId),
      manifestHash: 'a'.repeat(64),
      inputHash: null,
      status,
      terminal: status === 'completed' ? { status: 'completed', stopReason: 'end_turn' } : null,
      metrics: null,
      origin: null,
      parentRunId: null,
      createdAt: MOCK_EPOCH,
      startedAt: MOCK_EPOCH,
      finishedAt: status === 'completed' ? MOCK_EPOCH + 5_000 : null,
    };
  };

  let runCounter = 0;

  /**
   * Publish a permission resolution onto the run that raised the request.
   *
   * The renderer closes the card because the PROJECTION stops awaiting an
   * answer, and the projection only learns that from an event. So the mock
   * appends the resolution to the run's script and lets the ordinary
   * durable-window poll carry it — no special path, no renderer knowledge.
   */
  const publishPermissionResolution = (
    requested: HostPermissionRequest,
    resolved: HostPermissionRequest,
  ): void => {
    for (const state of runs.values()) {
      if (state.fixture.sessionId !== requested.sessionId) continue;
      const seq = state.fixture.events.length + state.extraEvents.length + 1;
      const denied = resolved.status === 'deny';
      state.extraEvents.push({
        runId: state.fixture.runId,
        sessionId: state.fixture.sessionId,
        seq,
        timestamp: MOCK_EPOCH + seq * 1000,
        traceId: `trace-${state.fixture.runId}`,
        payload: {
          type: 'permission.resolved',
          requestId: requested.id,
          action: denied ? 'deny' : 'allow',
          source: 'host',
          latencyMs: 1_000,
          ...(resolved.message === null ? {} : { reason: resolved.message }),
        },
      } as unknown as RunEventEnvelope);
      // The request is answered: the run may settle now.
      state.settled = true;
    }
  };

  return {
    listSessions(query?: HostSessionListQuery): Promise<HostSessionPage> {
      // The Host knows EVERY session. Grouping them into projects is the
      // renderer's job, so a session with no project (a fresh draft) is still
      // a session the Host can answer for.
      const items: HostSessionListItem[] = MOCK_THREADS.map((thread) => ({
        session: toSessionRecord(thread),
        timelineCount: 2,
      }));
      const filtered = query?.workspaceId === undefined
        ? items
        : items.filter((item) => item.session.workspace.state === 'bound');
      return Promise.resolve({ sessions: filtered, nextCursor: null });
    },

    getSession(sessionId: SessionId): Promise<HostSessionRecord | null> {
      return Promise.resolve(sessions.get(sessionId) ?? null);
    },

    createSession(input: HostSessionCreateInput): Promise<HostSessionRecord> {
      const id = input.id ?? `mock-session-created-${(runCounter += 1)}`;
      const record: HostSessionRecord = {
        id,
        workspace: { state: 'legacy_unbound' },
        title: input.title ?? '新对话',
        projectName: input.projectName ?? '',
        status: 'idle',
        model: input.model ?? 'mock-model',
        providerId: input.providerId ?? 'mock-provider',
        mode: input.mode ?? 'default',
        permissionMode: input.permissionMode ?? 'default',
        agentProfileId: input.agentProfileId ?? null,
        parentSessionId: input.parentSessionId ?? null,
        agentType: 'main',
        agentName: '独雅',
        draft: null,
        extensions: {},
        createdAt: MOCK_EPOCH,
        updatedAt: MOCK_EPOCH,
        recencyAt: MOCK_EPOCH,
        lastTurnStartedAt: null,
      };
      sessions.set(id, record);
      return Promise.resolve(record);
    },

    updateSession(
      sessionId: SessionId,
      expectedUpdatedAt: number | undefined,
      patch: HostSessionPatch,
    ): Promise<HostSessionUpdateResult> {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        return Promise.resolve({ updated: false, reason: 'not_found' });
      }
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== existing.updatedAt) {
        return Promise.resolve({ updated: false, reason: 'conflict' });
      }
      const updated: HostSessionRecord = {
        ...existing,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.projectName === undefined ? {} : { projectName: patch.projectName }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.providerId === undefined ? {} : { providerId: patch.providerId }),
        ...(patch.mode === undefined ? {} : { mode: patch.mode }),
        ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
        ...(patch.draft === undefined ? {} : { draft: patch.draft }),
        updatedAt: existing.updatedAt + 1,
      };
      sessions.set(sessionId, updated);
      return Promise.resolve({ updated: true, session: updated });
    },

    deleteSession(sessionId: SessionId): Promise<HostSessionDeleteResult> {
      if (!sessions.delete(sessionId)) {
        return Promise.resolve({ deleted: false, reason: 'not_found' });
      }
      return Promise.resolve({ deleted: true });
    },

    readMessages(sessionId: SessionId): Promise<HostMessagePage> {
      // The mock's transcripts live in the conversation store (seeded by the
      // mock entry), not in the Host's durable projection. The page is empty
      // on purpose: the renderer reads the transcript through its own store.
      return Promise.resolve({ sessionId, messages: [], nextCursor: null });
    },

    readAllMessages(
      sessionId: SessionId,
      _query?: HostMessageReadAllQuery,
    ): Promise<HostMessagePage> {
      return Promise.resolve({ sessionId, messages: [], nextCursor: null });
    },

    listRuns(sessionId: SessionId, limit?: number): Promise<readonly AgentRunRecord[]> {
      const records = [...runs.values()]
        .filter((state) => state.fixture.sessionId === sessionId)
        .map(toRunRecord)
        .sort((left, right) => left.createdAt - right.createdAt);
      return Promise.resolve(limit === undefined ? records : records.slice(-limit));
    },

    startRun(input: StartAgentRunInput): Promise<StartAgentRunResult> {
      runCounter += 1;
      const runId = `mock-run-live-${runCounter}`;
      const events = buildLiveScript(runId, input);
      runs.set(runId, {
        fixture: { runId, sessionId: input.sessionId, events, open: false },
        deliveredSeq: 0,
        settled: false,
        extraEvents: [],
      });
      return Promise.resolve({ accepted: true, stage: 'created', runId });
    },

    cancelRun(runId: RunId): Promise<CancelAgentRunResult> {
      const state = runs.get(runId);
      if (state === undefined) {
        return Promise.resolve({ requested: false, runId, reason: 'run_not_found' });
      }
      state.settled = true;
      return Promise.resolve({ requested: true, runId, terminal: { status: 'cancelled' } });
    },

    readRunEvents(runId: RunId, afterSeq: number, limit?: number): Promise<readonly RunEventEnvelope[]> {
      const state = runs.get(runId);
      if (state === undefined) return Promise.resolve([]);
      const size = limit ?? EVENTS_PER_READ;
      const all = [...state.fixture.events, ...state.extraEvents];
      const pending = all.filter((event) => event.seq > afterSeq);
      const batch = pending.slice(0, Math.min(size, EVENTS_PER_READ));
      state.deliveredSeq = batch.reduce((highest, event) => Math.max(highest, event.seq), state.deliveredSeq);
      return Promise.resolve(batch);
    },

    listPendingApprovals(sessionId?: SessionId): Promise<readonly HostPermissionRequest[]> {
      const pending = [...approvals.values()].filter((request) => request.status === 'pending');
      const scoped = sessionId === undefined
        ? pending
        : pending.filter((request) => request.sessionId === sessionId);
      return Promise.resolve(scoped);
    },

    resolveApproval(
      requestId: string,
      input: HostPermissionRequestResolveInput,
    ): Promise<HostPermissionRequest | null> {
      const existing = approvals.get(requestId);
      if (existing === undefined) return Promise.resolve(null);
      const resolved: HostPermissionRequest = {
        ...existing,
        status: input.status === 'deny' ? 'deny' : 'allow',
        decision: input.decision ?? input.status,
        message: input.message ?? null,
        resolvedAt: MOCK_EPOCH + 1_000,
      };
      approvals.set(requestId, resolved);
      // Publish the resolution on the run's event stream, the way a real Host
      // does. The renderer's permission card reads the PROJECTION, so without
      // this event the card would stay open forever.
      publishPermissionResolution(existing, resolved);
      return Promise.resolve(resolved);
    },

    getProviderCatalog(): Promise<HostProviderCatalog | null> {
      return Promise.resolve(MOCK_PROVIDER_CATALOG);
    },

    getLatestTurnSuggestion(sessionId: SessionId) {
      return Promise.resolve({
        id: `mock-suggestion-${sessionId}`,
        sessionId,
        turnId: 'mock-turn',
        suggestion: '把侧栏的分组维度再收敛一版',
        createdAt: MOCK_EPOCH,
      });
    },

    debugRuns: () => [...runs.values()].map(toRunRecord),
  };
}

/**
 * The script for a turn the user just sent.
 *
 * It echoes the prompt so the mock's composer is honest about what it did:
 * nothing ran, and the reply says so.
 */
function buildLiveScript(runId: string, input: StartAgentRunInput): RunEventEnvelope[] {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const reply = [
    '这是 mock 环境的回复：没有任何 worker 在跑。',
    '',
    `你刚发的是：「${prompt.slice(0, 60)}」`,
    '',
    '用来验证的只有**结构**：侧栏、面板、消息区怎么摆。',
  ].join('\n');
  const events: RunEventEnvelope[] = [];
  let seq = 0;
  const push = (payload: Record<string, unknown>): void => {
    seq += 1;
    events.push({
      runId,
      sessionId: input.sessionId,
      seq,
      timestamp: MOCK_EPOCH + seq * 1000,
      traceId: `trace-${runId}`,
      payload: { type: 'unknown', ...payload },
    } as unknown as RunEventEnvelope);
  };
  push({
    type: 'run.started',
    manifestHash: 'a'.repeat(64),
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'duya-mock', version: '0.0.0-mock' },
  });
  push({
    type: 'turn.started',
    turnId: `${runId}-turn-1`,
    index: 0,
    model: 'mock-model',
    providerId: 'mock-provider',
    apiFormat: 'anthropic',
  });
  const messageId = `${runId}-msg-1`;
  for (const delta of reply.match(/[\s\S]{1,18}/g) ?? []) {
    push({ type: 'assistant.text_delta', messageId, index: 0, delta });
  }
  push({
    type: 'assistant.message_finalized',
    messageId,
    content: [{ type: 'text', text: reply }],
    stopReason: 'end_turn',
  });
  push({
    type: 'turn.completed',
    turnId: `${runId}-turn-1`,
    index: 0,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    durationMs: 10,
  });
  push({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
  return events;
}
