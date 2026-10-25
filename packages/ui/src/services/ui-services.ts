import type {
  CancelAgentRunResult,
  HostMessagePage,
  HostMessageReadAllQuery,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestResolveInput,
  HostProviderCatalog,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  HostWorkspaceBinding,
  RunId,
  SessionId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type { RunSessionSnapshot } from '@duya/client-core';

/** Read-only view of a single authoritative RunSession projection. */
export interface UiRunSession {
  getSnapshot(): RunSessionSnapshot;
  /** Latest durable Host ledger status; null until the first ledger read. */
  getDurableStatus(): UiRunRecord['status'] | null;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  settled(): Promise<void>;
}

/** Durable run fields needed by chat attachment and the cancellation ledger. */
export interface UiRunRecord {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly status: 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface UiPlatformCapabilities {
  readonly localFileAccess: boolean;
  readonly settings: boolean;
  readonly extensions: boolean;
  readonly bots: boolean;
  readonly automation: boolean;
  readonly workflows: boolean;
  /**
   * Can this surface hand the user's TURN CONFIGURATION to the Host — the
   * permission mode, the agent profile, the declared modes and tools?
   *
   * This is a capability, not a platform identity: the question a surface
   * answers is "can the thing the user picked reach the worker", and a
   * surface that cannot answer it must not draw a control that silently does
   * nothing. A surface whose transport carries those fields sets it; one
   * whose transport cannot does not.
   */
  readonly turnConfiguration: boolean;
}

/**
 * What the shared renderer asks for when it starts a turn.
 *
 * `StartAgentRunInput` plus the thinking-effort level the composer picked.
 * The level is NOT a protocol field: the Host carries it as a turn OPTION,
 * which is the same channel the Desktop renderer uses, so both surfaces
 * reach the worker with the same turn configuration.
 *
 * The turn's CONFIGURATION is named here too — the permission mode, the agent
 * profile, the modes and tools — because a surface that cannot name them
 * would produce turns that run under different rules than the user picked,
 * without anything saying so.
 */
export interface UiStartRunInput extends StartAgentRunInput {
  readonly effort?: string;
}

/** Finite business operations the shared renderer needs from its host. */
export interface UiServices {
  readonly platform: 'web' | 'desktop';
  readonly capabilities: UiPlatformCapabilities;
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
    /**
     * The WHOLE message projection, projected once.
     *
     * The paged read re-projects the entire transcript on every page, so a
     * client that reads a transcript end to end through the pages pays for it
     * once per page. A client that wants the whole transcript asks for it here.
     */
    readAllMessages(sessionId: SessionId, query?: HostMessageReadAllQuery): Promise<HostMessagePage>;
  };
  readonly runs: {
    listBySession(sessionId: SessionId, limit?: number, signal?: AbortSignal): Promise<readonly UiRunRecord[]>;
    start(input: UiStartRunInput): Promise<StartAgentRunResult>;
    cancel(runId: string, reason?: string): Promise<CancelAgentRunResult>;
    /** Open one run projection; renderers must subscribe to its snapshot, not reduce envelopes. */
    openSession(runId: RunId, sessionId: SessionId, signal: AbortSignal): UiRunSession;
  };
  readonly approvals: {
    listPending(sessionId?: SessionId): Promise<readonly HostPermissionRequest[]>;
    resolve(
      requestId: string,
      input: HostPermissionRequestResolveInput,
    ): Promise<HostPermissionRequest | null>;
  };
  /**
   * The provider/model roster, when the surface can read one.
   *
   * OPTIONAL. A surface whose Host has no provider catalog leaves the
   * namespace out, and the model picker then shows nothing — which is the
   * truth. `null` says the same thing for a surface that HAS the namespace
   * but whose Host has no roster.
   *
   * A surface that HAS a roster must show THAT one: the roster the Host
   * adjudicates a turn's model against, not a copy the surface kept for
   * itself.
   */
  readonly providers?: {
    catalog(): Promise<HostProviderCatalog | null>;
  };
  /**
   * Register a local directory as a workspace, when the surface can.
   *
   * OPTIONAL. A surface whose Host cannot register a directory — the Desktop,
   * where the user picks a folder through the OS — leaves it out, and the
   * renderer then asks the Desktop's own path picker instead.
   *
   * The surface names a DIRECTORY and the Host returns the workspace BINDING.
   * It never names the path the worker runs in: that is the Host's to decide,
   * and the binding is the only thing a session may carry.
   */
  readonly registerWorkspace?: (directory: string) => Promise<HostWorkspaceBinding>;
}
