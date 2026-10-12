import type { RunEventEnvelope } from './envelope.js';
import type { RunManifest } from './manifest.js';
import type { RunId, SessionId } from './primitives.js';
import type { RunMetrics, RunTerminalState } from './run.js';

export type AgentRunOrigin = 'user' | 'agent' | 'background';

export interface CreateAgentRunInput {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly origin?: AgentRunOrigin;
  readonly parentRunId?: RunId;
}

export type CreateAgentRunResult =
  | { readonly state: 'created'; readonly runId: RunId }
  | { readonly state: 'reused'; readonly runId: RunId };

export type SettleAgentRunResult =
  | { readonly state: 'applied' }
  | { readonly state: 'reconciled'; readonly committed: RunTerminalState }
  | { readonly state: 'conflict'; readonly committed: RunTerminalState }
  | { readonly state: 'absent' };

export interface AgentRunRecord {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  readonly inputHash: string | null;
  readonly status: 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  readonly terminal: RunTerminalState | null;
  readonly metrics: RunMetrics | null;
  readonly origin: AgentRunOrigin | null;
  readonly parentRunId: RunId | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Present for a single-run read; omitted from session lists. */
  readonly eventCount?: number;
}

export interface AgentRunEventQuery {
  /** Exclusive sequence cursor. */
  readonly afterSeq?: number;
  readonly limit?: number;
}

/** Authenticated Host boundary for durable Agent Run records and events. */
export interface HostRunApiV1 {
  createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunResult>;
  getAgentRun(runId: RunId): Promise<AgentRunRecord | null>;
  listAgentRunsBySession(sessionId: SessionId, limit?: number): Promise<readonly AgentRunRecord[]>;
  appendAgentRunEvents(runId: RunId, events: readonly RunEventEnvelope[]): Promise<number>;
  settleAgentRun(
    runId: RunId,
    terminal: RunTerminalState,
    metrics?: RunMetrics,
  ): Promise<SettleAgentRunResult>;
  readAgentRunEvents(
    runId: RunId,
    query?: AgentRunEventQuery,
  ): Promise<readonly RunEventEnvelope[]>;
}
