import type {
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
  readonly conductor: boolean;
  readonly bots: boolean;
  readonly automation: boolean;
  readonly workflows: boolean;
}

/**
 * What the shared renderer asks for when it starts a turn.
 *
 * `StartAgentRunInput` plus the thinking-effort level the composer picked.
 * The level is NOT a protocol field: the Host carries it as a turn OPTION,
 * which is the same channel the Desktop renderer uses, so both surfaces
 * reach the worker with the same turn configuration.
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
}
