import type {
  HostLocalSessionImportInput,
  HostLocalSessionImportResult,
  HostLocalSessionRollbackResult,
  HostSessionArchiveResult,
  HostSessionApiV1,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionForkInput,
  HostSessionForkResult,
  HostLocalRolloutImportInput,
  HostWorkspaceFileReadInput,
  HostWorkspaceFileReadResult,
  HostRolloutExportResult,
  HostRolloutImportResult,
  HostRolloutReconcileResult,
  HostMessagePage,
  HostMessageReadQuery,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionPermissionProfileInput,
  HostSessionRecord,
  HostSessionSearchQuery,
  HostSessionSearchResult,
  HostMessageSearchResult,
  HostMessageSearchQuery,
  HostSessionChangeStats,
  HostSessionUpdateResult,
  HostTimelineAppendInput,
  HostTimelinePage,
  HostTimelineReadQuery,
  HostTimelineWriteReceipt,
  HostWorkspaceBinding,
  HostWorkspaceRegistrationApiV1,
  HostLocalAttachmentApiV1,
  HostLocalImageAttachment,
  HostLocalParsedDocument,
  HostLocalParsedDocumentInput,
  HostLocalSettingsApiV1,
  HostLocalSessionSummary,
  HostLocalSessionSummaryQuery,
  SessionPermissionProfile,
} from '@duya/agent-protocol/session-api';
import type {
  AgentRunRecord,
  AgentRunEventQuery,
  AgentRunEventStreamQuery,
  CreateAgentRunInput,
  CreateAgentRunResult,
  HostHealthApiV1,
  HostHealthV1,
  HostRunApiV1,
  CancelAgentRunResult,
  StartAgentRunInput,
  StartAgentRunResult,
  AgentTaskStatus,
  HostTaskApiV1,
  SessionId,
  Task,
  TaskClaimResult,
  TaskCreateInput,
  TaskId,
  TaskUpdateInput,
  UnassignTeammateTasksResult,
  RunEventEnvelope,
  RunId,
  RunMetrics,
  RunTerminalState,
  RunAttemptFence,
  SettleAgentRunResult,
  UnfencedRunWriteAuthorization,
  HostCapability,
  HostDeclaration,
  ProtocolCapability,
  ProtocolVersion,
} from '@duya/agent-protocol';
import type { HostResearchAction, HostResearchApiV1 } from '@duya/agent-protocol/research-api';
import type {
  HostLocalTerminalHistoryApiV1,
  TerminalHistoryQuery,
  TerminalHistoryRecordInput,
  TerminalHistorySuggestion,
} from '@duya/agent-protocol/terminal-history';
import type {
  HostLocalSessionApiV1,
  HostLocalSessionPage,
} from './local-session-api.js';
import type {
  HostLocalProjectApiV1,
  HostLocalProjectResolution,
  HostLocalProjectResolutionInput,
} from './local-project-api.js';
import type { HostLocalRolloutApiV1 } from './local-rollout-api.js';
import type { CoreSession } from '@duya/data/session-store';
import type {
  WorkflowRunApiV1,
  WorkflowRun,
  WorkflowRunCreateInput,
  WorkflowRunFilter,
  WorkflowRunOutcomeInput,
  WorkflowRunSnapshot,
  WorkflowRunSnapshotSaveInput,
  WorkflowRunStatus,
} from '@duya/agent-protocol/workflow-runs';
import type { JournalRecord } from '@duya/agent-protocol';
import type {
  GoalBudgetDelta,
  GoalCreateInput,
  GoalStatus,
  HostGoalApiV1,
  SessionGoal,
} from '@duya/agent-protocol/goals';
import type {
  HostModeStateApiV1,
  ModeStateRow,
  ModeStateUpsertInput,
} from '@duya/agent-protocol/mode-state';
import type {
  HostPermissionRequest,
  HostPermissionRequestApiV1,
  HostPermissionRequestCreateInput,
  HostPermissionRequestResolveInput,
} from '@duya/agent-protocol';
import type {
  HostToolApproval,
  HostToolApprovalApiV1,
  HostToolApprovalDecision,
  HostToolApprovalInput,
  HostToolApprovalResolution,
  HostToolApprovalScopeType,
} from '@duya/agent-protocol';
import type {
  HostLockApiV1,
  HostProjectApiV1,
  HostProjectCreateInput,
  HostProjectPatch,
  HostProjectRecord,
  HostLockAcquireInput,
  HostLockRenewInput,
  HostLockReleaseInput,
  LockOrigin,
} from '@duya/agent-protocol';
import type {
  HostLocalMailboxApiV1,
  HostMailboxApplyInput,
  HostMailboxClaimBatchInput,
  HostMailboxClaimBatchResult,
  HostMailboxEditInput,
  HostMailboxEnqueueInput,
  HostMailboxItem,
  HostMailboxStatus,
  HostMailboxCancelByAgentInput,
} from '@duya/agent-protocol/mailbox';
import type {
  HostLocalPendingWakeApiV1,
  HostPendingWakeInput,
  HostPendingWakeKind,
  HostPendingWakeRow,
} from '@duya/agent-protocol';
import type {
  GatewayUserMapping,
  GatewayUserMappingInput,
  HostLocalGatewayUserMapApiV1,
} from '@duya/agent-protocol/gateway-user-map';
import type {
  ChannelBindingInput,
  ChannelBindingRow,
  ChannelOffsetInput,
  ChannelOffsetRow,
  HostLocalChannelPersistenceApiV1,
  WeixinContextTokenInput,
} from '@duya/agent-protocol/channel-persistence';
import type {
  AgentProfileCreateInput,
  AgentProfileRow,
  AgentProfileUpdateInput,
  HostLocalAgentProfileApiV1,
} from '@duya/agent-protocol/agent-profiles';
import type {
  GatewayChannelDirectoryEntry,
  HostLocalGatewayDirectoryApiV1,
} from '@duya/agent-protocol/gateway-directory';
import type {
  GatewayAllowlist,
  HostLocalGatewayAllowlistApiV1,
} from '@duya/agent-protocol/gateway-allowlist';
import type {
  GatewayMessageMirrorInput,
  HostLocalGatewayMessageMirrorApiV1,
} from '@duya/agent-protocol/gateway-message-mirror';
import type {
  GatewayThreadWriteInput,
  HostLocalGatewayThreadApiV1,
} from '@duya/agent-protocol/gateway-threads';
import type {
  CreateSecretPendingInput,
  CreateWidgetPendingInput,
  CursorAgentRunInput,
  HostLocalSendMessageStateApiV1,
  MarkSecretProvidedInput,
  UpdateCursorAgentRunInput,
  UpdateWidgetResponseInput,
} from '@duya/agent-protocol/send-message-state';
import type {
  HostLocalModelCapabilityApiV1,
  ModelCapabilityRecord,
  ModelCapabilityWriteInput,
  HostLocalProviderModelCapabilityApiV1,
  ProviderModelCapabilityRecord,
} from '@duya/agent-protocol/model-capabilities';
import type { HostProviderCatalog } from '@duya/agent-protocol/provider-catalog';
import type {
  HostAppConnectionRecord,
  HostAppConnectionStatus,
  HostAppConnectionStatusPatch,
  HostAppConnectionWriteInput,
  HostLocalAppConnectionApiV1,
} from '@duya/agent-protocol/app-connections';
import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import type {
  HostPluginAppInstanceApiV1,
  HostPluginAppInstanceCreateInput,
  HostPluginAppInstanceWriteInput,
  HostPluginAppInstanceStatusInput,
  PluginAppInstanceRecord,
  PluginAppInstanceWriteResult,
  PluginAppInstanceStatusResult,
  HostPluginAppInvocationApiV1,
  PluginAppInvocationBindInput,
  PluginAppInvocationBinding,
  PluginAppInvocationInput,
  PluginAppInvocationResult,
} from '@duya/agent-protocol';
import type {
  HostLocalSidebarSectionsApiV1,
  SidebarSection,
  SidebarSectionCreateInput,
  SidebarSectionPatch,
  SidebarSectionProject,
  SidebarSectionsSnapshot,
} from '@duya/agent-protocol/sidebar-sections';
import type { HostLocalUsageApiV1, HostLocalUsageIndex } from '@duya/agent-protocol/usage-api';
import type {
  CreateHostImportBatchInput,
  CreateHostImportBatchItemInput,
  HostImportBatch,
  HostImportBatchItem,
  HostLocalImportBatchApiV1,
} from '@duya/agent-protocol/import-batches';
import type {
  HostLocalTurnReviewApiV1,
  HostLocalTurnReviewRecord,
  HostLocalTurnReviewSummary,
  TurnReviewWriteInput,
} from '@duya/agent-protocol/turn-review';

const REQUEST_TIMEOUT_MS = 5_000;
// Leave headroom for the Agent Server's existing 30s IPC request deadline.
const RUN_REQUEST_TIMEOUT_MS = 25_000;

export class HostSessionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /**
     * The attempt numbers behind a `409 attempt_fenced`, when the refusing hop
     * reported them on the error payload.
     *
     * Carried because a fenced refusal and a conflict are opposite instructions
     * for the caller — drop the batch, or reconcile with the committed terminal —
     * and collapsing them at the HTTP boundary would force the caller to guess
     * which one it is looking at.
     */
    readonly fenced?: { readonly presented: number; readonly current: number | null },
  ) {
    super(message ?? `Duya Host request failed (${status}: ${code})`);
    this.name = 'HostSessionHttpError';
  }
}

/**
 * What the Host answers a handshake with, on top of the legacy health payload.
 *
 * Every field here is ADDITIVE and optional. An older Host answers `/healthz`
 * with `ok`/`apiVersion`/`databaseReady` and nothing else, which is why the
 * client gate treats a missing `provides` as a refusal rather than as an
 * all-clear: an absent declaration is not a declaration of everything.
 *
 * The two axes stay separate on purpose. `consumedBy` echoes what the CLIENT
 * can consume (`PROTOCOL_CAPABILITIES`); `provides` is what the HOST can serve
 * (`HOST_CAPABILITIES`). Collapsing them is the mistake
 * `agent-protocol/src/version.ts:116` exists to make impossible.
 */
export interface HostHandshakeV1 extends HostHealthV1 {
  readonly host?: { readonly name: string; readonly version: string; readonly kind: 'desktop' | 'web' | 'headless' };
  readonly protocol?: ProtocolVersion;
  readonly schemaRevision?: number;
  /** What this Host can actually serve, derived from the APIs it registered. */
  readonly provides?: readonly HostCapability[];
  readonly limits?: { readonly maxFileBytes?: number; readonly absentCapabilityPolicy?: 'error' | 'disable' };
  /** A stated reason for every name missing from `provides`. */
  readonly unsupported?: Readonly<Record<string, string>>;
  /** Echo of the consume-side declaration the client sent with the handshake. */
  readonly consumedBy?: readonly ProtocolCapability[];
}

/**
 * Declare what this client can consume, and read back what the Host provides.
 *
 * The declaration travels as a header rather than as a query string so the
 * existing `/healthz` contract, its status code and its `ok` flag are untouched
 * for any older client that still calls `getHealth()`.
 */
export const HOST_DECLARATION_HEADER = 'x-duya-host-declaration';

/** Typed client for the versioned Host session, timeline, and task APIs. */
export class HostSessionHttpClient implements
  HostSessionApiV1,
  HostLocalSessionApiV1,
  HostLocalProjectApiV1,
  HostLocalRolloutApiV1,
  HostLocalAttachmentApiV1,
  HostLocalSettingsApiV1,
  HostLocalGatewayUserMapApiV1,
  HostLocalChannelPersistenceApiV1,
  HostLocalAgentProfileApiV1,
  HostLocalGatewayDirectoryApiV1,
  HostLocalGatewayAllowlistApiV1,
  HostLocalGatewayMessageMirrorApiV1,
  HostLocalGatewayThreadApiV1,
  HostLocalSendMessageStateApiV1,
  HostLocalModelCapabilityApiV1,
  HostLocalProviderModelCapabilityApiV1,
  HostLocalAppConnectionApiV1,
  HostLocalPluginSetupApiV1,
  HostPluginAppInstanceApiV1,
  HostPluginAppInvocationApiV1,
  HostLocalSidebarSectionsApiV1,
  HostLocalUsageApiV1,
  HostLocalImportBatchApiV1,
  HostLocalTurnReviewApiV1,
  HostLocalTerminalHistoryApiV1,
  HostLocalMailboxApiV1,
  HostLocalPendingWakeApiV1,
  WorkflowRunApiV1,
  HostWorkspaceRegistrationApiV1,
  HostTaskApiV1,
  HostGoalApiV1,
  HostModeStateApiV1,
  HostPermissionRequestApiV1,
  HostToolApprovalApiV1,
  HostLockApiV1,
  HostRunApiV1,
  HostProjectApiV1,
  HostResearchApiV1,
  HostHealthApiV1 {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  async getHealth(): Promise<HostHealthV1> {
    return this.request('GET', '/healthz');
  }

  /** Declare what this client consumes, and read the Host capability answer. */
  async handshake(declaration: HostDeclaration): Promise<HostHandshakeV1> {
    return this.request('GET', '/healthz', undefined, REQUEST_TIMEOUT_MS, {
      [HOST_DECLARATION_HEADER]: JSON.stringify(declaration),
    });
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunResult> {
    return this.request('POST', '/v1/agent-runs', input, RUN_REQUEST_TIMEOUT_MS);
  }

  /** Start a Host-supervised run (plan 12 gate 3). */
  async startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult> {
    return this.request('POST', '/v1/agent-runs/start', input, RUN_REQUEST_TIMEOUT_MS);
  }

  /** Ask the Host to stop a run it supervises. */
  async cancelAgentRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult> {
    return this.request(
      'POST',
      `/v1/agent-runs/${encodeURIComponent(runId)}/cancel`,
      { reason },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  async getAgentRun(runId: RunId): Promise<AgentRunRecord | null> {
    const result = await this.request<{ run: AgentRunRecord | null }>(
      'GET',
      `/v1/agent-runs/${encodeURIComponent(runId)}`,
      undefined,
      RUN_REQUEST_TIMEOUT_MS,
    );
    return result.run;
  }

  async listAgentRunsBySession(sessionId: SessionId, limit?: number): Promise<readonly AgentRunRecord[]> {
    const params = new URLSearchParams({ sessionId });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request(
      'GET',
      `/v1/agent-runs?${params.toString()}`,
      undefined,
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  async appendAgentRunEvents(
    runId: RunId,
    events: readonly RunEventEnvelope[],
    fence: RunAttemptFence,
  ): Promise<number> {
    const result = await this.request<{ written: number }>(
      'POST',
      `/v1/agent-runs/${encodeURIComponent(runId)}/events`,
      { events, fence: toWireFence(fence) },
      RUN_REQUEST_TIMEOUT_MS,
    );
    return result.written;
  }

  async appendAgentRunEventsUnfenced(
    runId: RunId,
    events: readonly RunEventEnvelope[],
    authorization: UnfencedRunWriteAuthorization,
  ): Promise<number> {
    const result = await this.request<{ written: number }>(
      'POST',
      `/v1/agent-runs/${encodeURIComponent(runId)}/events`,
      { events, unfenced: authorization },
      RUN_REQUEST_TIMEOUT_MS,
    );
    return result.written;
  }

  async settleAgentRun(
    runId: RunId,
    terminal: RunTerminalState,
    fence: RunAttemptFence,
    metrics?: RunMetrics,
  ): Promise<SettleAgentRunResult> {
    return this.request(
      'POST',
      `/v1/agent-runs/${encodeURIComponent(runId)}/terminal`,
      { terminal, fence: toWireFence(fence), ...(metrics === undefined ? {} : { metrics }) },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  async settleAgentRunUnfenced(
    runId: RunId,
    terminal: RunTerminalState,
    authorization: UnfencedRunWriteAuthorization,
    metrics?: RunMetrics,
  ): Promise<SettleAgentRunResult> {
    return this.request(
      'POST',
      `/v1/agent-runs/${encodeURIComponent(runId)}/terminal`,
      { terminal, unfenced: authorization, ...(metrics === undefined ? {} : { metrics }) },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  async readAgentRunEvents(
    runId: RunId,
    query: AgentRunEventQuery = {},
  ): Promise<readonly RunEventEnvelope[]> {
    const params = new URLSearchParams();
    if (query.afterSeq !== undefined) params.set('afterSeq', String(query.afterSeq));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const result = await this.request<{ events: readonly RunEventEnvelope[] }>(
      'GET',
      `/v1/agent-runs/${encodeURIComponent(runId)}/events${suffix}`,
      undefined,
      RUN_REQUEST_TIMEOUT_MS,
    );
    return result.events;
  }

  async *watchAgentRunEvents(
    runId: RunId,
    query: AgentRunEventStreamQuery = {},
  ): AsyncIterable<RunEventEnvelope> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'text/event-stream',
    };
    if (query.afterSeq !== undefined) headers['last-event-id'] = String(query.afterSeq);

    const response = await fetch(
      `${this.origin}/v1/agent-runs/${encodeURIComponent(runId)}/events/stream${suffix}`,
      { headers, ...(query.signal === undefined ? {} : { signal: query.signal }) },
    );
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new HostSessionHttpError(response.status, 'invalid_response');
      }
      throw hostErrorFromPayload(response.status, payload);
    }
    if (!response.body) throw new HostSessionHttpError(502, 'missing_event_stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // The durable log can omit non-durable envelopes, so seq may jump. It must
    // remain strictly increasing for a valid exclusive reconnect cursor.
    let lastSeq = query.afterSeq ?? 0;
    try {
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        buffer += decoder.decode(chunk.value, { stream: !done });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const parsed = parseServerSentFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'error') throw hostStreamError(parsed.data);
          if (parsed.event !== 'run') continue;
          const envelope = parseRunEventEnvelope(parsed.data, runId);
          if (envelope.seq <= lastSeq) throw new HostSessionHttpError(502, 'run_event_sequence_regression');
          lastSeq = envelope.seq;
          yield envelope;
        }
      }
      if (buffer.trim().length > 0) {
        const parsed = parseServerSentFrame(buffer);
        if (parsed?.event === 'error') throw hostStreamError(parsed.data);
        if (parsed?.event === 'run') {
          const envelope = parseRunEventEnvelope(parsed.data, runId);
          if (envelope.seq <= lastSeq) throw new HostSessionHttpError(502, 'run_event_sequence_regression');
          lastSeq = envelope.seq;
          yield envelope;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (!query.signal?.aborted) {
      const run = await this.getAgentRun(runId);
      if (run === null) throw new HostSessionHttpError(404, 'run_not_found');
      if (run.terminal === null) throw new HostSessionHttpError(502, 'run_event_stream_ended');
    }
  }

  async createPermissionRequest(input: HostPermissionRequestCreateInput): Promise<HostPermissionRequest> {
    const result = await this.request<{ permission: HostPermissionRequest }>(
      'POST',
      '/v1/permission-requests',
      input,
    );
    return result.permission;
  }

  async getPermissionRequest(id: string): Promise<HostPermissionRequest | null> {
    const result = await this.request<{ permission: HostPermissionRequest | null }>(
      'GET',
      `/v1/permission-requests/${encodeURIComponent(id)}`,
    );
    return result.permission;
  }

  async listPendingPermissionRequests(sessionId?: string): Promise<readonly HostPermissionRequest[]> {
    const query = sessionId === undefined ? '' : `?${new URLSearchParams({ sessionId }).toString()}`;
    return this.request('GET', `/v1/permission-requests${query}`);
  }

  async resolvePermissionRequest(
    id: string,
    input: HostPermissionRequestResolveInput,
  ): Promise<HostPermissionRequest | null> {
    const result = await this.request<{ permission: HostPermissionRequest | null }>(
      'POST',
      `/v1/permission-requests/${encodeURIComponent(id)}/resolve`,
      input,
    );
    return result.permission;
  }

  async createToolApproval(input: HostToolApprovalInput): Promise<HostToolApproval> {
    const result = await this.request<{ approval: HostToolApproval }>('POST', '/v1/tool-approvals', input);
    return result.approval;
  }

  async getToolApproval(id: string): Promise<HostToolApproval | null> {
    const result = await this.request<{ approval: HostToolApproval | null }>(
      'GET',
      `/v1/tool-approvals/${encodeURIComponent(id)}`,
    );
    return result.approval;
  }

  async listToolApprovalsBySession(sessionId: string): Promise<readonly HostToolApproval[]> {
    const query = new URLSearchParams({ sessionId });
    return this.request('GET', `/v1/tool-approvals?${query.toString()}`);
  }

  async resolveToolApproval(
    id: string,
    decision: HostToolApprovalDecision,
  ): Promise<HostToolApprovalResolution | null> {
    const result = await this.request<{ result: HostToolApprovalResolution | null }>(
      'POST',
      `/v1/tool-approvals/${encodeURIComponent(id)}/resolve`,
      { decision },
    );
    return result.result;
  }

  async consumeApprovedToolApproval(input: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly inputHash: string;
  }): Promise<boolean> {
    const result = await this.request<{ consumed: boolean }>(
      'POST',
      '/v1/tool-approvals/consume-approved',
      input,
    );
    return result.consumed;
  }

  async consumeToolApprovalById(id: string): Promise<HostToolApproval | null> {
    const result = await this.request<{ approval: HostToolApproval | null }>(
      'POST',
      `/v1/tool-approvals/${encodeURIComponent(id)}/consume`,
      {},
    );
    return result.approval;
  }

  async upsertToolApprovalRule(input: {
    readonly scopeType: HostToolApprovalScopeType;
    readonly scopeId: string;
    readonly toolName: string;
  }): Promise<void> {
    await this.request<{ ok: true }>('POST', '/v1/tool-approvals/rules', input);
  }

  async listToolApprovalRules(input: {
    readonly scopeType: HostToolApprovalScopeType;
    readonly scopeId: string;
  }): Promise<readonly string[]> {
    const query = new URLSearchParams({ scopeType: input.scopeType, scopeId: input.scopeId });
    return this.request('GET', `/v1/tool-approvals/rules?${query.toString()}`);
  }

  async acquireLock(input: HostLockAcquireInput): Promise<boolean> {
    const result = await this.request<{ acquired: boolean }>('POST', '/v1/locks/acquire', input);
    return result.acquired;
  }

  async renewLock(input: HostLockRenewInput): Promise<boolean> {
    const result = await this.request<{ renewed: boolean }>('POST', '/v1/locks/renew', input);
    return result.renewed;
  }

  async releaseLock(input: HostLockReleaseInput): Promise<boolean> {
    const result = await this.request<{ released: boolean }>('POST', '/v1/locks/release', input);
    return result.released;
  }

  async isSessionLocked(sessionId: string): Promise<boolean> {
    const result = await this.request<{ locked: boolean }>(
      'GET',
      `/v1/locks/${encodeURIComponent(sessionId)}/status`,
    );
    return result.locked;
  }

  async getSessionLockOrigin(sessionId: string): Promise<LockOrigin | null> {
    const result = await this.request<{ origin: LockOrigin | null }>(
      'GET',
      `/v1/locks/${encodeURIComponent(sessionId)}/origin`,
    );
    return result.origin;
  }

  async createRun(input: WorkflowRunCreateInput): Promise<WorkflowRun> {
    return this.request('POST', '/v1/workflow-runs', input);
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(id)}`);
  }

  async getRunByDedupKey(dedupKey: string): Promise<WorkflowRun | null> {
    return this.request('GET', `/v1/workflow-runs/by-dedup-key/${encodeURIComponent(dedupKey)}`);
  }

  async listRuns(filter: WorkflowRunFilter = {}): Promise<WorkflowRun[]> {
    const params = new URLSearchParams();
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.workflowName !== undefined) params.set('workflowName', filter.workflowName);
    if (filter.origin !== undefined) params.set('origin', filter.origin);
    if (filter.parentSessionId !== undefined) params.set('parentSessionId', filter.parentSessionId);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString();
    return this.request('GET', `/v1/workflow-runs${query ? `?${query}` : ''}`);
  }

  async listActiveRunIds(): Promise<string[]> {
    return this.request('GET', '/v1/workflow-runs/active');
  }

  async updateStatus(id: string, status: WorkflowRunStatus, pauseMessage?: string | null): Promise<boolean> {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(id)}/status`, { status, pauseMessage });
  }

  async finishRun(id: string, outcome: WorkflowRunOutcomeInput): Promise<boolean> {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(id)}/finish`, outcome);
  }

  async setWaitTill(id: string, waitTill: number | null): Promise<boolean> {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(id)}/wait-till`, { waitTill });
  }

  async setVersionId(id: string, versionId: string): Promise<boolean> {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(id)}/version`, { versionId });
  }

  async listWaitingPast(nowMs: number): Promise<WorkflowRun[]> {
    return this.request('GET', `/v1/workflow-runs/waiting-past?now=${encodeURIComponent(String(nowMs))}`);
  }

  async reconcileStaleRuns(activeRunIds: readonly string[]): Promise<WorkflowRun[]> {
    return this.request('POST', '/v1/workflow-runs/reconcile-stale', { activeRunIds });
  }

  async saveSnapshot(snapshot: WorkflowRunSnapshotSaveInput): Promise<boolean> {
    return this.request('PUT', `/v1/workflow-runs/${encodeURIComponent(snapshot.runId)}/snapshot`, snapshot);
  }

  async loadSnapshot(runId: string): Promise<WorkflowRunSnapshot | null> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}/snapshot`);
  }

  async appendJournalRecord(runId: string, record: JournalRecord): Promise<boolean> {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(runId)}/journal`, { record });
  }

  async listEvents(runId: string, afterSeq = -1): Promise<JournalRecord[]> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}/events?afterSeq=${encodeURIComponent(String(afterSeq))}`);
  }

  async latestEventSeq(runId: string): Promise<number | null> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}/events/latest`);
  }

  async getEventCount(runId: string): Promise<number> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}/events/count`);
  }

  async loadJournal(runId: string): Promise<JournalRecord[]> {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}/journal`);
  }

  async deleteRun(id: string): Promise<boolean> {
    return this.request('DELETE', `/v1/workflow-runs/${encodeURIComponent(id)}`);
  }

  async getGoal(sessionId: string): Promise<SessionGoal | null> {
    return this.request('GET', `/v1/goals/${encodeURIComponent(sessionId)}`);
  }

  async getOrCreateGoal(input: GoalCreateInput): Promise<SessionGoal> {
    return this.request('POST', '/v1/goals', input);
  }

  async updateBudget(sessionId: string, delta: GoalBudgetDelta): Promise<SessionGoal | null> {
    return this.request('POST', `/v1/goals/${encodeURIComponent(sessionId)}/budget`, delta);
  }

  async setStatus(sessionId: string, status: GoalStatus): Promise<SessionGoal | null> {
    return this.request('POST', `/v1/goals/${encodeURIComponent(sessionId)}/status`, { status });
  }

  async listByStatus(status: GoalStatus): Promise<SessionGoal[]> {
    return this.request('GET', `/v1/goals?status=${encodeURIComponent(status)}`);
  }

  async getModeState(sessionId: string, mode: string): Promise<ModeStateRow | null> {
    return this.request(
      'GET',
      `/v1/mode-state/${encodeURIComponent(sessionId)}/${encodeURIComponent(mode)}`,
    );
  }

  async upsertModeState(input: ModeStateUpsertInput): Promise<void> {
    await this.request(
      'POST',
      `/v1/mode-state/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.mode)}`,
      input,
    );
  }

  async setModeStateStatus(sessionId: string, mode: string, status: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/mode-state/${encodeURIComponent(sessionId)}/${encodeURIComponent(mode)}/status`,
      { status },
    );
  }

  async listModeStateBySession(sessionId: string): Promise<ModeStateRow[]> {
    return this.request('GET', `/v1/mode-state/${encodeURIComponent(sessionId)}`);
  }

  async create(input: HostSessionCreateInput): Promise<HostSessionRecord> {
    const result = await this.request<{ session: HostSessionRecord }>('POST', '/v1/sessions', input);
    return result.session;
  }

  async resolveSessionPermissionProfile(
    input: HostSessionPermissionProfileInput,
  ): Promise<SessionPermissionProfile> {
    const result = await this.request<{ permissionProfile: SessionPermissionProfile }>(
      'POST',
      '/v1/session-permission-profile',
      input,
    );
    return result.permissionProfile;
  }

  async registerLocalDirectory(
    directory: string,
  ): Promise<Extract<HostWorkspaceBinding, { readonly state: 'bound' }>> {
    const result = await this.request<{
      workspace: Extract<HostWorkspaceBinding, { readonly state: 'bound' }>;
    }>(
      'POST',
      '/v1/workspaces/local-directories',
      { directory },
    );
    return result.workspace;
  }

  async get(
    sessionId: string,
    options: { readonly includeAllSessions?: boolean } = {},
  ): Promise<HostSessionRecord | null> {
    try {
      const params = new URLSearchParams();
      if (options.includeAllSessions) params.set('includeAllSessions', 'true');
      const query = params.toString();
      const result = await this.request<{ session: HostSessionRecord }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`,
      );
      return result.session;
    } catch (error) {
      if (error instanceof HostSessionHttpError && error.status === 404 && error.code === 'session_not_found') {
        return null;
      }
      throw error;
    }
  }

  async readLocalSession(
    sessionId: string,
    options: { readonly includeAllSessions?: boolean } = {},
  ): Promise<CoreSession | null> {
    try {
      const params = new URLSearchParams();
      if (options.includeAllSessions) params.set('includeAllSessions', 'true');
      const query = params.toString();
      const result = await this.request<{ session: CoreSession }>(
        'GET',
        `/v1/local/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`,
      );
      return result.session;
    } catch (error) {
      if (error instanceof HostSessionHttpError && error.status === 404 && error.code === 'session_not_found') {
        return null;
      }
      throw error;
    }
  }

  async list(query: HostSessionListQuery = {}): Promise<HostSessionPage> {
    const params = new URLSearchParams();
    if (query.workspaceId !== undefined) params.set('workspaceId', query.workspaceId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.parentSessionId !== undefined) params.set('parentSessionId', query.parentSessionId);
    if (query.includeArchived !== undefined) params.set('includeArchived', String(query.includeArchived));
    if (query.includeAllSessions !== undefined) params.set('includeAllSessions', String(query.includeAllSessions));
    if (query.includeDeleted !== undefined) params.set('includeDeleted', String(query.includeDeleted));
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    return this.request('GET', `/v1/sessions${suffix}`);
  }

  async searchSessions(
    query: string,
    options: HostSessionSearchQuery = {},
  ): Promise<HostSessionSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.includeContent !== undefined) params.set('includeContent', String(options.includeContent));
    return this.request('GET', `/v1/search/sessions?${params.toString()}`);
  }

  async searchMessages(
    query: string,
    options?: number | HostMessageSearchQuery,
  ): Promise<HostMessageSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (typeof options === 'number') params.set('limit', String(options));
    else if (options) {
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      for (const sessionId of options.sessionIds ?? []) params.append('sessionId', sessionId);
    }
    return this.request('GET', `/v1/search/messages?${params.toString()}`);
  }

  async getSessionChangeStats(sessionId: string): Promise<HostSessionChangeStats> {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/change-stats`);
  }

  async listLocalSessions(query: HostSessionListQuery = {}): Promise<HostLocalSessionPage> {
    const params = new URLSearchParams();
    if (query.workspaceId !== undefined) params.set('workspaceId', query.workspaceId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.parentSessionId !== undefined) params.set('parentSessionId', query.parentSessionId);
    if (query.includeArchived !== undefined) params.set('includeArchived', String(query.includeArchived));
    if (query.includeAllSessions !== undefined) params.set('includeAllSessions', String(query.includeAllSessions));
    if (query.includeDeleted !== undefined) params.set('includeDeleted', String(query.includeDeleted));
    const queryString = params.toString();
    return this.request('GET', `/v1/local/sessions${queryString ? `?${queryString}` : ''}`);
  }

  async listLocalSessionSummariesByPrefix(
    query: HostLocalSessionSummaryQuery,
  ): Promise<readonly HostLocalSessionSummary[]> {
    const params = new URLSearchParams({ idPrefix: query.idPrefix });
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    return this.request('GET', `/v1/local/session-summaries?${params.toString()}`);
  }

  async resolveProjectPath(
    input: HostLocalProjectResolutionInput,
  ): Promise<HostLocalProjectResolution> {
    return this.request('POST', '/v1/local/projects/resolve-path', input);
  }

  async update(
    sessionId: string,
    expectedUpdatedAt: number | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult> {
    return this.request('PATCH', `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      patch,
    });
  }

  async delete(sessionId: string, expectedUpdatedAt?: number): Promise<HostSessionDeleteResult> {
    const suffix = expectedUpdatedAt === undefined ? '' : `?expectedUpdatedAt=${expectedUpdatedAt}`;
    return this.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`);
  }

  async archive(sessionId: string): Promise<HostSessionArchiveResult> {
    const result = await this.request<{ result: HostSessionArchiveResult }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
    );
    return result.result;
  }

  async unarchive(sessionId: string): Promise<boolean> {
    const result = await this.request<{ unarchived: boolean }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/unarchive`,
    );
    return result.unarchived;
  }

  async forkAt(sourceSessionId: string, input: HostSessionForkInput): Promise<HostSessionForkResult> {
    return this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sourceSessionId)}/fork-at`,
      input,
    );
  }

  async reconcileRollouts(): Promise<HostRolloutReconcileResult> {
    return this.request('POST', '/v1/rollouts/reconcile');
  }

  async importRollout(input: HostLocalRolloutImportInput): Promise<HostRolloutImportResult> {
    return this.request('POST', '/v1/local/rollouts/import', input);
  }

  /**
   * Read one file out of a workspace, addressed by Workspace identity.
   *
   * No absolute path: the client names a workspace and a relative path, and the
   * Host resolves it. There is therefore nothing here for a caller to point at
   * a file outside the workspace — the question does not have a spelling.
   */
  async readWorkspaceFile(input: HostWorkspaceFileReadInput): Promise<HostWorkspaceFileReadResult> {
    return this.request('POST', '/v1/workspace/file', input);
  }

  async createImportedSession(input: HostLocalSessionImportInput): Promise<HostLocalSessionImportResult> {
    return this.request('POST', '/v1/local/sessions/import', input);
  }

  async rollbackImportedSessions(sessionIds: readonly SessionId[]): Promise<HostLocalSessionRollbackResult> {
    return this.request('POST', '/v1/local/sessions/import/rollback', { sessionIds });
  }

  async exportRollout(sessionId: string, destinationDirectory?: string): Promise<HostRolloutExportResult> {
    return this.request('POST', '/v1/local/rollouts/export', {
      sessionId,
      ...(destinationDirectory === undefined ? {} : { destinationDirectory }),
    });
  }

  async storeParsedDocument(input: HostLocalParsedDocumentInput): Promise<{ readonly success: boolean }> {
    return this.request('POST', '/v1/local/parsed-documents', input);
  }

  async getParsedDocumentsForSession(sessionId: SessionId): Promise<readonly HostLocalParsedDocument[]> {
    return this.request(
      'GET',
      `/v1/local/sessions/${encodeURIComponent(sessionId)}/parsed-documents`,
    );
  }

  async getImageAttachmentsForSession(sessionId: SessionId): Promise<readonly HostLocalImageAttachment[]> {
    return this.request(
      'GET',
      `/v1/local/sessions/${encodeURIComponent(sessionId)}/image-attachments`,
    );
  }

  async getParsedDocumentsForMessage(messageId: string): Promise<readonly HostLocalParsedDocument[]> {
    return this.request(
      'GET',
      `/v1/local/messages/${encodeURIComponent(messageId)}/parsed-documents`,
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const params = new URLSearchParams({ key });
    const result = await this.request<{ value: string | null }>(
      'GET',
      `/v1/local/settings?${params.toString()}`,
    );
    return result.value;
  }

  async getSettings(): Promise<Readonly<Record<string, string>>> {
    return this.request('GET', '/v1/local/settings');
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.request('POST', '/v1/local/settings', { key, value });
  }

  async findGatewayUserMapping(platform: string, platformChatId: string): Promise<GatewayUserMapping | null> {
    const params = new URLSearchParams({ platform, platformChatId });
    const result = await this.request<{ mapping: GatewayUserMapping | null }>(
      'GET',
      `/v1/local/gateway-user-map?${params.toString()}`,
    );
    return result.mapping;
  }

  async findGatewayUserMappingBySession(sessionId: string): Promise<GatewayUserMapping | null> {
    const params = new URLSearchParams({ sessionId });
    const result = await this.request<{ mapping: GatewayUserMapping | null }>(
      'GET',
      `/v1/local/gateway-user-map?${params.toString()}`,
    );
    return result.mapping;
  }

  async listGatewayUserMappings(platform?: string): Promise<readonly GatewayUserMapping[]> {
    const params = new URLSearchParams();
    if (platform !== undefined) params.set('platform', platform);
    const result = await this.request<{ mappings: readonly GatewayUserMapping[] }>(
      'GET',
      `/v1/local/gateway-user-map${params.size > 0 ? `?${params.toString()}` : ''}`,
    );
    return result.mappings;
  }

  async upsertGatewayUserMapping(input: GatewayUserMappingInput): Promise<void> {
    await this.request('POST', '/v1/local/gateway-user-map', input);
  }

  async listChannelBindings(channelType?: string): Promise<readonly ChannelBindingRow[]> {
    const params = new URLSearchParams();
    if (channelType !== undefined) params.set('channelType', channelType);
    const result = await this.request<{ bindings: readonly ChannelBindingRow[] }>(
      'GET',
      `/v1/local/channel-bindings${params.size > 0 ? `?${params.toString()}` : ''}`,
    );
    return result.bindings;
  }

  async getChannelBinding(channelType: string, chatId: string): Promise<ChannelBindingRow | null> {
    const params = new URLSearchParams({ channelType, chatId });
    const result = await this.request<{ binding: ChannelBindingRow | null }>(
      'GET',
      `/v1/local/channel-bindings?${params.toString()}`,
    );
    return result.binding;
  }

  async upsertChannelBinding(input: ChannelBindingInput): Promise<ChannelBindingRow | null> {
    const result = await this.request<{ binding: ChannelBindingRow | null }>(
      'POST',
      '/v1/local/channel-bindings',
      input,
    );
    return result.binding;
  }

  async listAgentProfiles(): Promise<readonly AgentProfileRow[]> {
    const result = await this.request<{ profiles: readonly AgentProfileRow[] }>(
      'GET',
      '/v1/local/agent-profiles',
    );
    return result.profiles;
  }

  async getAgentProfile(id: string): Promise<AgentProfileRow | null> {
    const result = await this.request<{ profile: AgentProfileRow | null }>(
      'GET',
      `/v1/local/agent-profiles?${new URLSearchParams({ id }).toString()}`,
    );
    return result.profile;
  }

  async createAgentProfile(input: AgentProfileCreateInput): Promise<AgentProfileRow | null> {
    const result = await this.request<{ profile: AgentProfileRow | null }>(
      'POST',
      '/v1/local/agent-profiles',
      input,
    );
    return result.profile;
  }

  async updateAgentProfile(id: string, input: AgentProfileUpdateInput): Promise<AgentProfileRow | null> {
    const result = await this.request<{ profile: AgentProfileRow | null }>(
      'PATCH',
      `/v1/local/agent-profiles?${new URLSearchParams({ id }).toString()}`,
      input,
    );
    return result.profile;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      'DELETE',
      `/v1/local/agent-profiles?${new URLSearchParams({ id }).toString()}`,
    );
    return result.deleted;
  }

  async getChannelOffset(channelType: string, offsetKey: string): Promise<ChannelOffsetRow | null> {
    const params = new URLSearchParams({ channelType, offsetKey });
    const result = await this.request<{ offset: ChannelOffsetRow | null }>(
      'GET',
      `/v1/local/channel-offsets?${params.toString()}`,
    );
    return result.offset;
  }

  async setChannelOffset(input: ChannelOffsetInput): Promise<void> {
    await this.request('POST', '/v1/local/channel-offsets', input);
  }

  async getWeixinContextToken(accountId: string, peerUserId: string): Promise<string | null> {
    const params = new URLSearchParams({ accountId, peerUserId });
    const result = await this.request<{ contextToken: string | null }>(
      'GET',
      `/v1/local/weixin-context-tokens?${params.toString()}`,
    );
    return result.contextToken;
  }

  async setWeixinContextToken(input: WeixinContextTokenInput): Promise<void> {
    await this.request('POST', '/v1/local/weixin-context-tokens', input);
  }

  async deleteWeixinContextTokens(accountId: string): Promise<void> {
    const params = new URLSearchParams({ accountId });
    await this.request('DELETE', `/v1/local/weixin-context-tokens?${params.toString()}`);
  }

  async listGatewayChannels(platform?: string): Promise<readonly GatewayChannelDirectoryEntry[]> {
    const params = new URLSearchParams();
    if (platform !== undefined) params.set('platform', platform);
    const result = await this.request<{ channels: readonly GatewayChannelDirectoryEntry[] }>(
      'GET',
      `/v1/local/gateway-directory${params.size > 0 ? `?${params.toString()}` : ''}`,
    );
    return result.channels;
  }

  async replaceGatewayChannels(
    platform: string,
    channels: readonly Omit<GatewayChannelDirectoryEntry, 'platform'>[],
  ): Promise<void> {
    await this.request('POST', '/v1/local/gateway-directory/replace', { platform, channels });
  }

  async getGatewayAllowlist(): Promise<GatewayAllowlist> {
    const result = await this.request<{ allowlist: GatewayAllowlist }>(
      'GET',
      '/v1/local/gateway-allowlist',
    );
    return result.allowlist;
  }

  async isGatewayUserAllowed(platform: string, platformUserId: string): Promise<boolean> {
    const result = await this.request<{ allowed: boolean }>(
      'GET',
      `/v1/local/gateway-allowlist/check?${new URLSearchParams({ platform, platformUserId }).toString()}`,
    );
    return result.allowed;
  }

  async addGatewayAllowlistEntry(platform: string, platformUserId: string): Promise<void> {
    await this.request('POST', '/v1/local/gateway-allowlist/add', { platform, platformUserId });
  }

  async removeGatewayAllowlistEntry(platform: string, platformUserId: string): Promise<void> {
    await this.request('POST', '/v1/local/gateway-allowlist/remove', { platform, platformUserId });
  }

  async appendGatewayMessageMirror(input: GatewayMessageMirrorInput): Promise<{ readonly id: string }> {
    return this.request('POST', '/v1/local/gateway-messages/mirror', input);
  }

  async getGatewayThreadTitle(sessionId: string): Promise<string | null> {
    const result = await this.request<{ title: string | null }>(
      'GET',
      `/v1/local/gateway-threads/title?${new URLSearchParams({ sessionId }).toString()}`,
    );
    return result.title;
  }

  async ensureGatewayThread(input: GatewayThreadWriteInput): Promise<void> {
    await this.request('POST', '/v1/local/gateway-threads/ensure', input);
  }

  async resetGatewayThread(input: GatewayThreadWriteInput): Promise<void> {
    await this.request('POST', '/v1/local/gateway-threads/reset', input);
  }

  async setGatewayThreadTitle(input: GatewayThreadWriteInput): Promise<void> {
    await this.request('POST', '/v1/local/gateway-threads/title', input);
  }

  async touchGatewayThread(sessionId: string, updatedAt: number): Promise<void> {
    await this.request('POST', '/v1/local/gateway-threads/touch', { sessionId, updatedAt });
  }

  async createWidgetPending(input: CreateWidgetPendingInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/widget-pending', input);
  }

  async updateWidgetResponse(input: UpdateWidgetResponseInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/widget-response', input);
  }

  async upsertCursorAgentRun(input: CursorAgentRunInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/cursor-agent-run', input);
  }

  async updateCursorAgentRun(input: UpdateCursorAgentRunInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/cursor-agent-run-status', input);
  }

  async createSecretPending(input: CreateSecretPendingInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/secret-pending', input);
  }

  async markSecretProvided(input: MarkSecretProvidedInput): Promise<void> {
    await this.request('POST', '/v1/local/send-message-state/secret-status', input);
  }

  async getModelCapability(modelName: string): Promise<ModelCapabilityRecord | null> {
    const result = await this.request<{ capability: ModelCapabilityRecord | null }>(
      'GET',
      `/v1/local/model-capability?${new URLSearchParams({ modelName }).toString()}`,
    );
    return result.capability;
  }

  async setModelCapability(input: ModelCapabilityWriteInput): Promise<{ readonly success: true }> {
    return this.request('POST', '/v1/local/model-capability/set', input);
  }

  async deleteModelCapability(modelName: string): Promise<{ readonly success: boolean }> {
    return this.request('POST', '/v1/local/model-capability/delete', { modelName });
  }

  /**
   * The configured provider/model catalog.
   *
   * This is what the model picker reads: the configured providers and the
   * models they serve. The capability table next to it holds OVERRIDES and is
   * empty on most machines, so it cannot answer "which models can I pick".
   */
  async getProviderCatalog(): Promise<HostProviderCatalog> {
    const result = await this.request<{ catalog: HostProviderCatalog }>(
      'GET',
      '/v1/local/provider-catalog',
    );
    return result.catalog;
  }

  async listProviderModelCapabilities(providerId: string): Promise<readonly ProviderModelCapabilityRecord[]> {
    const query = new URLSearchParams({ providerId });
    const result = await this.request<{ capabilities: readonly ProviderModelCapabilityRecord[] }>(
      'GET',
      `/v1/local/provider-model-capability?${query.toString()}`,
    );
    return result.capabilities;
  }

  async getProviderModelCapability(
    providerId: string,
    modelId: string,
  ): Promise<ProviderModelCapabilityRecord | null> {
    const query = new URLSearchParams({ providerId, modelId });
    const result = await this.request<{ capability: ProviderModelCapabilityRecord | null }>(
      'GET',
      `/v1/local/provider-model-capability?${query.toString()}`,
    );
    return result.capability;
  }

  async upsertProviderModelCapability(
    capability: ProviderModelCapabilityRecord,
  ): Promise<ProviderModelCapabilityRecord> {
    const result = await this.request<{ capability: ProviderModelCapabilityRecord }>(
      'POST',
      '/v1/local/provider-model-capability/set',
      { capability },
    );
    return result.capability;
  }

  async deleteProviderModelCapability(
    providerId: string,
    modelId: string,
  ): Promise<{ readonly success: boolean }> {
    return this.request('POST', '/v1/local/provider-model-capability/delete', { providerId, modelId });
  }

  async listAppConnections(): Promise<readonly HostAppConnectionRecord[]> {
    const result = await this.request<{ connections: readonly HostAppConnectionRecord[] }>(
      'GET',
      '/v1/local/app-connections',
    );
    return result.connections;
  }

  async listAppConnectionsByProvider(provider: string): Promise<readonly HostAppConnectionRecord[]> {
    const query = new URLSearchParams({ provider });
    const result = await this.request<{ connections: readonly HostAppConnectionRecord[] }>(
      'GET',
      `/v1/local/app-connections?${query.toString()}`,
    );
    return result.connections;
  }

  async getAppConnection(id: string): Promise<HostAppConnectionRecord | null> {
    const query = new URLSearchParams({ id });
    const result = await this.request<{ connection: HostAppConnectionRecord | null }>(
      'GET',
      `/v1/local/app-connections/by-id?${query.toString()}`,
    );
    return result.connection;
  }

  async upsertAppConnection(input: HostAppConnectionWriteInput): Promise<HostAppConnectionRecord> {
    const result = await this.request<{ connection: HostAppConnectionRecord }>(
      'POST',
      '/v1/local/app-connections/upsert',
      input,
    );
    return result.connection;
  }

  async updateAppConnectionStatus(
    id: string,
    status: HostAppConnectionStatus,
    patch?: HostAppConnectionStatusPatch,
  ): Promise<HostAppConnectionRecord | null> {
    const result = await this.request<{ connection: HostAppConnectionRecord | null }>(
      'POST',
      '/v1/local/app-connections/status',
      { id, status, ...patch },
    );
    return result.connection;
  }

  async removeAppConnection(id: string): Promise<boolean> {
    const result = await this.request<{ removed: boolean }>(
      'POST',
      '/v1/local/app-connections/remove',
      { id },
    );
    return result.removed;
  }

  async createPluginAppInstance(input: HostPluginAppInstanceCreateInput): Promise<PluginAppInstanceRecord> {
    const result = await this.request<{ instance: PluginAppInstanceRecord }>(
      'POST', '/v1/local/plugin-app-instances', input,
    );
    return result.instance;
  }

  async getPluginAppInstance(instanceId: string): Promise<PluginAppInstanceRecord | null> {
    const result = await this.request<{ instance: PluginAppInstanceRecord | null }>(
      'GET', `/v1/local/plugin-app-instances/${encodeURIComponent(instanceId)}`,
    );
    return result.instance;
  }

  async listPluginAppInstances(pluginId: string, appId?: string): Promise<readonly PluginAppInstanceRecord[]> {
    const query = new URLSearchParams({ pluginId });
    if (appId !== undefined) query.set('appId', appId);
    const result = await this.request<{ instances: PluginAppInstanceRecord[] }>(
      'GET', `/v1/local/plugin-app-instances?${query.toString()}`,
    );
    return result.instances;
  }

  async writePluginAppInstanceState(
    instanceId: string, input: HostPluginAppInstanceWriteInput,
  ): Promise<PluginAppInstanceWriteResult> {
    return this.request('POST', `/v1/local/plugin-app-instances/${encodeURIComponent(instanceId)}/state`, input);
  }

  async setPluginAppInstanceStatus(
    instanceId: string, input: HostPluginAppInstanceStatusInput,
  ): Promise<PluginAppInstanceStatusResult> {
    return this.request('POST', `/v1/local/plugin-app-instances/${encodeURIComponent(instanceId)}/status`, input);
  }

  async bindPluginAppInvocation(input: PluginAppInvocationBindInput): Promise<PluginAppInvocationBinding> {
    const result = await this.request<{ binding: PluginAppInvocationBinding }>(
      'POST', '/v1/local/plugin-app-invocations/bind', input,
    );
    return result.binding;
  }

  async invokePluginAppTool(input: PluginAppInvocationInput): Promise<PluginAppInvocationResult> {
    return this.request(
      'POST',
      `/v1/local/plugin-app-invocations/${encodeURIComponent(input.bindingId)}/invoke`,
      {
        nonce: input.nonce,
        toolId: input.toolId,
        arguments: input.arguments,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    );
  }

  async revokePluginAppInvocation(bindingId: string, nonce: string): Promise<boolean> {
    const result = await this.request<{ revoked: boolean }>(
      'DELETE',
      `/v1/local/plugin-app-invocations/${encodeURIComponent(bindingId)}`,
      { nonce },
    );
    return result.revoked;
  }

  async listPluginSetupValues(): Promise<Record<string, Record<string, string>>> {
    const result = await this.request<{ values: Record<string, Record<string, string>> }>(
      'GET',
      '/v1/local/plugin-setup-values',
    );
    return result.values;
  }

  async mergePluginSetupValues(pluginId: string, values: Record<string, string>): Promise<void> {
    await this.request('POST', '/v1/local/plugin-setup-values', { pluginId, values });
  }

  async clearPluginSetupValues(pluginId: string): Promise<void> {
    await this.request('DELETE', `/v1/local/plugin-setup-values?${new URLSearchParams({ pluginId }).toString()}`);
  }

  async listSidebarSections(): Promise<SidebarSectionsSnapshot> {
    return this.request('GET', '/v1/local/sidebar-sections');
  }

  async getUsageIndex(): Promise<HostLocalUsageIndex> {
    return this.request('GET', '/v1/local/usage/index');
  }

  async createSidebarSection(input: SidebarSectionCreateInput): Promise<SidebarSection> {
    const result = await this.request<{ section: SidebarSection }>('POST', '/v1/local/sidebar-sections', input);
    return result.section;
  }

  async updateSidebarSection(id: string, patch: SidebarSectionPatch): Promise<SidebarSection | null> {
    const query = new URLSearchParams({ id });
    const result = await this.request<{ section: SidebarSection | null }>(
      'PATCH',
      `/v1/local/sidebar-sections/section?${query.toString()}`,
      patch,
    );
    return result.section;
  }

  async deleteSidebarSection(id: string): Promise<boolean> {
    const query = new URLSearchParams({ id });
    const result = await this.request<{ deleted: boolean }>(
      'DELETE',
      `/v1/local/sidebar-sections/section?${query.toString()}`,
    );
    return result.deleted;
  }

  async assignSidebarProject(sectionId: string, workingDirectory: string): Promise<SidebarSectionProject> {
    const result = await this.request<{ project: SidebarSectionProject }>(
      'POST',
      '/v1/local/sidebar-sections/project/assign',
      { sectionId, workingDirectory },
    );
    return result.project;
  }

  async unassignSidebarProject(workingDirectory: string): Promise<void> {
    await this.request('POST', '/v1/local/sidebar-sections/project/unassign', { workingDirectory });
  }

  async reorderSidebarSections(orderedIds: readonly string[]): Promise<void> {
    await this.request('POST', '/v1/local/sidebar-sections/reorder', { orderedIds });
  }

  async reorderSidebarProjects(sectionId: string, orderedDirectories: readonly string[]): Promise<void> {
    await this.request('POST', '/v1/local/sidebar-sections/project/reorder', { sectionId, orderedDirectories });
  }

  async findSidebarSectionForProject(workingDirectory: string): Promise<string | null> {
    const query = new URLSearchParams({ workingDirectory });
    const result = await this.request<{ sectionId: string | null }>(
      'GET',
      `/v1/local/sidebar-sections/project/section?${query.toString()}`,
    );
    return result.sectionId;
  }

  async createBatch(input: CreateHostImportBatchInput): Promise<HostImportBatch> {
    const result = await this.request<{ batch: HostImportBatch }>('POST', '/v1/local/import-batches', input);
    return result.batch;
  }

  async addItem(input: CreateHostImportBatchItemInput): Promise<HostImportBatchItem> {
    const { batchId, ...item } = input;
    const result = await this.request<{ item: HostImportBatchItem }>(
      'POST',
      `/v1/local/import-batches/${encodeURIComponent(batchId)}/items`,
      item,
    );
    return result.item;
  }

  async updateBatchStatus(batchId: string, status: string, appliedItems: number): Promise<void> {
    await this.request(
      'PATCH',
      `/v1/local/import-batches/${encodeURIComponent(batchId)}`,
      { status, appliedItems },
    );
  }

  async rollbackBatchItems(batchId: string): Promise<void> {
    await this.request('POST', `/v1/local/import-batches/${encodeURIComponent(batchId)}/rollback`, {});
  }

  async getBatchItems(batchId: string): Promise<HostImportBatchItem[]> {
    const result = await this.request<{ items: HostImportBatchItem[] }>(
      'GET',
      `/v1/local/import-batches/${encodeURIComponent(batchId)}/items`,
    );
    return result.items;
  }

  async listBatches(): Promise<HostImportBatch[]> {
    const result = await this.request<{ batches: HostImportBatch[] }>('GET', '/v1/local/import-batches');
    return result.batches;
  }

  async saveTurnReview(input: TurnReviewWriteInput): Promise<void> {
    await this.request('POST', '/v1/local/turn-reviews', input);
  }

  async getLatestTurnReview(sessionId: string): Promise<HostLocalTurnReviewRecord | null> {
    const query = new URLSearchParams({ sessionId });
    const result = await this.request<{ review: HostLocalTurnReviewRecord | null }>(
      'GET',
      `/v1/local/turn-reviews/latest?${query.toString()}`,
    );
    return result.review;
  }

  async listTurnReviewHistory(
    sessionId: string,
    limit: number,
  ): Promise<readonly HostLocalTurnReviewSummary[]> {
    const query = new URLSearchParams({ sessionId, limit: String(limit) });
    const result = await this.request<{ reviews: readonly HostLocalTurnReviewSummary[] }>(
      'GET',
      `/v1/local/turn-reviews/history?${query.toString()}`,
    );
    return result.reviews;
  }

  async getTurnReviewById(reviewId: string): Promise<HostLocalTurnReviewRecord | null> {
    const query = new URLSearchParams({ reviewId });
    const result = await this.request<{ review: HostLocalTurnReviewRecord | null }>(
      'GET',
      `/v1/local/turn-reviews/by-id?${query.toString()}`,
    );
    return result.review;
  }

  async getTurnReviewByTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<HostLocalTurnReviewRecord | null> {
    const query = new URLSearchParams({ sessionId, turnId });
    const result = await this.request<{ review: HostLocalTurnReviewRecord | null }>(
      'GET',
      `/v1/local/turn-reviews/by-turn?${query.toString()}`,
    );
    return result.review;
  }

  async suggestTerminalHistory(query: TerminalHistoryQuery): Promise<readonly TerminalHistorySuggestion[]> {
    const result = await this.request<{ suggestions: readonly TerminalHistorySuggestion[] }>(
      'POST',
      '/v1/local/terminal-history/suggest',
      query,
    );
    return result.suggestions;
  }

  async recordTerminalCommand(input: TerminalHistoryRecordInput): Promise<void> {
    await this.request('POST', '/v1/local/terminal-history/record', input);
  }

  async getItem(id: string): Promise<HostMailboxItem | null> {
    const params = new URLSearchParams({ id });
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'GET',
      `/v1/local/mailbox/item?${params.toString()}`,
    );
    return result.item;
  }

  async getByClientMsgId(sessionId: string, clientMsgId: string): Promise<HostMailboxItem | null> {
    const params = new URLSearchParams({ sessionId, clientMsgId });
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'GET',
      `/v1/local/mailbox/by-client-message?${params.toString()}`,
    );
    return result.item;
  }

  async enqueue(input: HostMailboxEnqueueInput): Promise<HostMailboxItem> {
    const result = await this.request<{ item: HostMailboxItem }>(
      'POST',
      '/v1/local/mailbox/enqueue',
      input,
    );
    return result.item;
  }

  async edit(id: string, patch: HostMailboxEditInput): Promise<HostMailboxItem | null> {
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'POST',
      '/v1/local/mailbox/edit',
      { id, patch },
    );
    return result.item;
  }

  async guide(id: string): Promise<HostMailboxItem | null> {
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'POST',
      '/v1/local/mailbox/guide',
      { id },
    );
    return result.item;
  }

  async promoteQueued(id: string): Promise<HostMailboxItem | null> {
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'POST',
      '/v1/local/mailbox/promote-queued',
      { id },
    );
    return result.item;
  }

  async cancel(id: string, reason?: string): Promise<HostMailboxItem | null> {
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'POST',
      '/v1/local/mailbox/cancel',
      { id, ...(reason === undefined ? {} : { reason }) },
    );
    return result.item;
  }

  async cancelByAgent(input: HostMailboxCancelByAgentInput): Promise<HostMailboxItem | null> {
    const result = await this.request<{ item: HostMailboxItem | null }>(
      'POST',
      '/v1/local/mailbox/cancel-by-agent',
      input,
    );
    return result.item;
  }

  async claimBatch(input: HostMailboxClaimBatchInput): Promise<HostMailboxClaimBatchResult> {
    const result = await this.request<{ result: HostMailboxClaimBatchResult }>(
      'POST',
      '/v1/local/mailbox/claim-batch',
      input,
    );
    return result.result;
  }

  async apply(input: HostMailboxApplyInput): Promise<HostMailboxItem> {
    const result = await this.request<{ item: HostMailboxItem }>(
      'POST',
      '/v1/local/mailbox/apply',
      input,
    );
    return result.item;
  }

  async listMailboxItems(
    sessionId: string,
    options: { readonly status?: readonly HostMailboxStatus[]; readonly limit?: number } = {},
  ): Promise<readonly HostMailboxItem[]> {
    const params = new URLSearchParams({ sessionId });
    for (const status of options.status ?? []) params.append('status', status);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const result = await this.request<{ items: readonly HostMailboxItem[] }>(
      'GET',
      `/v1/local/mailbox/list?${params.toString()}`,
    );
    return result.items;
  }

  async listMailboxItemsForSession(sessionId: string): Promise<readonly HostMailboxItem[]> {
    const params = new URLSearchParams({ sessionId });
    const result = await this.request<{ items: readonly HostMailboxItem[] }>(
      'GET',
      `/v1/local/mailbox/list-for-session?${params.toString()}`,
    );
    return result.items;
  }

  async getPendingWake(kind: HostPendingWakeKind, workId: string): Promise<HostPendingWakeRow | null> {
    const params = new URLSearchParams({ kind, workId });
    const result = await this.request<{ item: HostPendingWakeRow | null }>(
      'GET',
      `/v1/local/pending-wakes/item?${params.toString()}`,
    );
    return result.item;
  }

  async persistPendingWake(input: HostPendingWakeInput): Promise<void> {
    await this.request('POST', '/v1/local/pending-wakes/persist', input);
  }

  async clearPendingWake(kind: HostPendingWakeKind, workId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      'POST',
      '/v1/local/pending-wakes/clear',
      { kind, workId },
    );
    return result.deleted;
  }

  async listPendingWakes(): Promise<readonly HostPendingWakeRow[]> {
    const result = await this.request<{ items: readonly HostPendingWakeRow[] }>(
      'GET',
      '/v1/local/pending-wakes',
    );
    return result.items;
  }

  async pruneStalePendingWakes(beforeMs?: number): Promise<number> {
    const result = await this.request<{ pruned: number }>(
      'POST',
      '/v1/local/pending-wakes/prune-stale',
      beforeMs === undefined ? {} : { beforeMs },
    );
    return result.pruned;
  }

  async countTimeline(sessionId: string): Promise<number> {
    const result = await this.request<{ count: number }>(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/timeline/count`,
    );
    return result.count;
  }

  async readMessages(sessionId: string, query: HostMessageReadQuery = {}): Promise<HostMessagePage> {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.includeSuperseded !== undefined) {
      params.set('includeSuperseded', String(query.includeSuperseded));
    }
    for (const source of query.sources ?? []) params.append('source', source);
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`);
  }

  async readTimeline(sessionId: string, query: HostTimelineReadQuery = {}): Promise<HostTimelinePage> {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/timeline${suffix}`);
  }

  async readProjectedTimeline(sessionId: string, query: HostTimelineReadQuery = {}): Promise<HostTimelinePage> {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    return this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/projected-timeline${suffix}`,
    );
  }

  async appendTimeline(sessionId: string, input: HostTimelineAppendInput): Promise<HostTimelineWriteReceipt> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/timeline`, input);
  }

  async deleteTimeline(sessionId: string): Promise<number> {
    const result = await this.request<{ deletedCount: number }>(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}/timeline`,
    );
    return result.deletedCount;
  }

  async getTask(taskId: TaskId): Promise<Task | null> {
    const result = await this.request<{ task: Task | null }>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
    return result.task;
  }

  async listTasks(sessionId: SessionId): Promise<Task[]> {
    const result = await this.request<{ tasks: Task[] }>(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
    );
    return result.tasks;
  }

  async listTasksByOwner(sessionId: SessionId, owner: string): Promise<Task[]> {
    const params = new URLSearchParams({ owner });
    const result = await this.request<{ tasks: Task[] }>(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks/by-owner?${params.toString()}`,
    );
    return result.tasks;
  }

  async createTask(sessionId: SessionId, input: TaskCreateInput): Promise<Task> {
    const result = await this.request<{ task: Task }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      input,
    );
    return result.task;
  }

  async updateTask(taskId: TaskId, updates: TaskUpdateInput): Promise<Task | null> {
    const result = await this.request<{ task: Task | null }>(
      'PATCH',
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      updates,
    );
    return result.task;
  }

  async deleteTask(taskId: TaskId): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`);
    return result.deleted;
  }

  async deleteTasksBySession(sessionId: SessionId): Promise<void> {
    await this.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
  }

  async claimTask(taskId: TaskId, owner: string): Promise<TaskClaimResult> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/claim`, { owner });
  }

  async blockTasks(fromTaskId: TaskId, toTaskId: TaskId): Promise<boolean> {
    const result = await this.request<{ blocked: boolean }>(
      'POST',
      `/v1/tasks/${encodeURIComponent(fromTaskId)}/blocks/${encodeURIComponent(toTaskId)}`,
      {},
    );
    return result.blocked;
  }

  async getAgentStatuses(sessionId: SessionId): Promise<AgentTaskStatus[]> {
    const result = await this.request<{ statuses: AgentTaskStatus[] }>(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks/statuses`,
    );
    return result.statuses;
  }

  async unassignTeammateTasks(
    sessionId: SessionId,
    owner: string,
  ): Promise<UnassignTeammateTasksResult> {
    return this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks/unassign`,
      { owner },
    );
  }

  async dispatch(
    action: HostResearchAction,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const result = await this.request<{ result: unknown }>(
      'POST',
      '/v1/research/actions',
      { action, payload },
    );
    return result.result;
  }

  async listProjects(): Promise<readonly HostProjectRecord[]> {
    const result = await this.request<{ projects: readonly HostProjectRecord[] }>('GET', '/v1/projects');
    return result.projects;
  }

  async getProject(projectId: string): Promise<HostProjectRecord | null> {
    const result = await this.request<{ project: HostProjectRecord | null }>(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
    return result.project;
  }

  async createProject(input: HostProjectCreateInput): Promise<HostProjectRecord> {
    const result = await this.request<{ project: HostProjectRecord }>('POST', '/v1/projects', input);
    return result.project;
  }

  async updateProject(projectId: string, patch: HostProjectPatch): Promise<HostProjectRecord | null> {
    const result = await this.request<{ project: HostProjectRecord | null }>(
      'PATCH',
      `/v1/projects/${encodeURIComponent(projectId)}`,
      patch,
    );
    return result.project;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      'DELETE',
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
    return result.deleted;
  }

  private async request<T>(
    method: string,
    requestPath: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.origin}${requestPath}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new HostSessionHttpError(response.status, 'invalid_response');
    }
    if (!response.ok) {
      // The shared reader, not an inline re-parse: this path used to be a
      // second copy of the same logic, so the fenced attempt pair was carried on
      // one error path and dropped on the other.
      throw hostErrorFromPayload(response.status, payload);
    }
    return payload as T;
  }
}

interface ServerSentFrame {
  readonly event: string;
  readonly data: string;
}

function parseServerSentFrame(frame: string): ServerSentFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}

function parseRunEventEnvelope(raw: string, runId: RunId): RunEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new HostSessionHttpError(502, 'invalid_run_event_frame');
  }
  if (
    !isObject(value) || value.runId !== runId || typeof value.sessionId !== 'string' ||
    !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 ||
    !Number.isSafeInteger(value.timestamp) || typeof value.traceId !== 'string' ||
    !isObject(value.payload) || typeof value.payload.type !== 'string'
  ) {
    throw new HostSessionHttpError(502, 'invalid_run_event_frame');
  }
  return value as unknown as RunEventEnvelope;
}

function hostStreamError(raw: string): HostSessionHttpError {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return new HostSessionHttpError(500, 'invalid_stream_error');
  }
  if (!isObject(value)) return new HostSessionHttpError(500, 'invalid_stream_error');
  const status = Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599
    ? Number(value.status)
    : 500;
  const code = typeof value.code === 'string' ? value.code : 'request_failed';
  const message = typeof value.message === 'string' ? value.message : undefined;
  return new HostSessionHttpError(status, code, message);
}

function hostErrorFromPayload(status: number, payload: unknown): HostSessionHttpError {
  const error = isObject(payload) ? payload.error : undefined;
  const code = isObject(error) && typeof error.code === 'string' ? error.code : 'request_failed';
  const message = isObject(error) && typeof error.message === 'string' ? error.message : undefined;
  const fenced = isObject(error) ? readFencedPair(error.fenced) : null;
  return new HostSessionHttpError(status, code, message, fenced ?? undefined);
}

/**
 * The attempt numbers a refusing hop reported, or `null`.
 *
 * Only read off the `attempt_fenced` payload and only when BOTH numbers are
 * well formed: a half-read pair would name an attempt nobody presented.
 */
function readFencedPair(value: unknown): { readonly presented: number; readonly current: number | null } | null {
  if (!isObject(value)) return null;
  const presented = value.presented;
  if (typeof presented !== 'number' || !Number.isSafeInteger(presented)) return null;
  const current = value.current;
  if (current === null) return { presented, current: null };
  if (typeof current === 'number' && Number.isSafeInteger(current)) return { presented, current };
  return null;
}

/**
 * The fence as it travels: a REQUIRED `fence` member, never a bare epoch.
 *
 * Serialized field by field rather than passed through, so a fence that lost its
 * writer on the way here cannot reach the server looking fenced.
 */
function toWireFence(fence: RunAttemptFence): { epoch: number; writer: string } {
  return { epoch: fence.epoch, writer: fence.writer };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
