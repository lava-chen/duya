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

export interface AgentRunEventStreamQuery extends AgentRunEventQuery {
  /** Stop watching when the caller no longer needs the live stream. */
  readonly signal?: AbortSignal;
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
  /** Follow durable events after an exclusive cursor until the run settles. */
  watchAgentRunEvents(
    runId: RunId,
    query?: AgentRunEventStreamQuery,
  ): AsyncIterable<RunEventEnvelope>;
}

/** One chat turn the caller wants executed by the Host. */
export interface StartAgentRunInput {
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly options?: Readonly<Record<string, unknown>>;
  /** Optional turn overrides; the Host falls back to the persisted session row. */
  readonly model?: string;
  readonly providerId?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly workingDirectory?: string;
  readonly origin?: AgentRunOrigin;
  /** Caller correlation id; the Host still mints the canonical run id. */
  readonly traceId?: string;
}

export type StartAgentRunStage =
  | 'created'
  | 'dispatched'
  | 'refused_no_session'
  | 'refused_run_open_failed'
  | 'refused_dispatch_failed';

export type StartAgentRunResult =
  | { readonly accepted: true; readonly stage: 'created' | 'dispatched'; readonly runId: RunId }
  | {
      readonly accepted: false;
      readonly stage: Exclude<StartAgentRunStage, 'created' | 'dispatched'>;
      readonly reason: string;
    };

export type CancelAgentRunResult =
  | { readonly requested: true; readonly runId: RunId }
  | { readonly requested: false; readonly runId: RunId; readonly reason: string };

/**
 * Authenticated Host boundary for STARTING and CANCELLING real runs.
 *
 * The ledger API above records what happened; this API makes the Host the
 * execution owner: a caller that can reach it can start a run the Host
 * supervises (worker dispatch, durable events, terminal settlement) and stop
 * one, without hosting any execution itself.
 */
export interface HostRunExecutionApiV1 {
  startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult>;
  cancelAgentRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult>;
}
