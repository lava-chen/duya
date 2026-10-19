import type {
  AgentRunRecord,
  CancelAgentRunResult,
  HostMessagePage,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestResolveInput,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  RunEventEnvelope,
  SessionId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';

/** Finite business operations the shared renderer needs from its host. */
export interface UiServices {
  readonly sessions: {
    list(query?: HostSessionListQuery): Promise<HostSessionPage>;
    get(sessionId: SessionId): Promise<HostSessionRecord | null>;
    create(input: HostSessionCreateInput): Promise<HostSessionRecord>;
    update(
      sessionId: SessionId,
      expectedUpdatedAt: number | undefined,
      patch: HostSessionPatch,
    ): Promise<HostSessionUpdateResult>;
    delete(sessionId: SessionId, expectedUpdatedAt?: number): Promise<HostSessionDeleteResult>;
    readMessages(sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage>;
  };
  readonly runs: {
    listBySession(sessionId: SessionId, limit?: number): Promise<readonly AgentRunRecord[]>;
    start(input: StartAgentRunInput): Promise<StartAgentRunResult>;
    cancel(runId: string, reason?: string): Promise<CancelAgentRunResult>;
    watchEvents(
      runId: string,
      query?: { readonly afterSeq?: number; readonly signal?: AbortSignal },
    ): AsyncIterable<RunEventEnvelope>;
  };
  readonly approvals: {
    listPending(sessionId?: SessionId): Promise<readonly HostPermissionRequest[]>;
    resolve(
      requestId: string,
      input: HostPermissionRequestResolveInput,
    ): Promise<HostPermissionRequest | null>;
  };
}
