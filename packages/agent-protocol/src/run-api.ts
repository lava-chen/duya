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
  /**
   * The attempt that asked for this terminal has been superseded.
   *
   * Not a `conflict`: no other writer decided this run's ending — this attempt
   * simply lost the right to decide it, so there is no `committed` terminal to
   * inspect and nothing to reconcile. A caller that reports it as a conflict
   * blames a rival writer for a decision it was never allowed to make.
   */
  | { readonly state: 'fenced'; readonly presented: number; readonly current: number | null }
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

/**
 * The attempt a writer presents, and who is presenting it.
 *
 * REQUIRED on every execution write. An executing writer always knows the
 * attempt it was opened under, so a fence it cannot name is a fence it cannot
 * enforce — and an `epoch?: number` parameter made "I forgot the attempt" and
 * "I deliberately have no attempt" the same value on the wire, with the first
 * one silently degrading into an unfenced write. A required object removes that
 * value: the compiler refuses the omission, and a boundary that only ever sees
 * `unknown` refuses it at runtime instead.
 *
 * `writer` is carried rather than assumed so a refusal can NAME the writer that
 * lost the fence instead of reporting an anonymous attempt.
 */
export interface RunAttemptFence {
  readonly epoch: number;
  readonly writer: string;
}

/**
 * The opt-in that authorizes a write with NO attempt at all.
 *
 * Deliberately unfenced maintenance — a bulk backfill, an administrative repair
 * — is a real need, so it stays reachable, but only by asking for it by name
 * with a reason and an author on the record. Nothing about it is reachable by
 * omitting an argument: the fenced methods above do not take it, and these two
 * refuse an authorization they cannot read.
 */
export interface UnfencedRunWriteAuthorization {
  readonly reason: string;
  readonly authorizedBy: string;
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
  /**
   * Append the Runtime-minted envelopes of one attempt, verbatim.
   *
   * `fence` is REQUIRED and cannot be `undefined`: see {@link RunAttemptFence}.
   * When the presented attempt has been superseded, storage must refuse the
   * write rather than accept it.
   */
  appendAgentRunEvents(
    runId: RunId,
    events: readonly RunEventEnvelope[],
    fence: RunAttemptFence,
  ): Promise<number>;
  /**
   * Land a terminal under the attempt that decided it.
   *
   * `fence` comes BEFORE the optional `metrics` on purpose: an optional
   * parameter may not precede a required one, and a fence that can be left out
   * of the argument list is exactly the fence this contract exists to make
   * unavoidable.
   */
  settleAgentRun(
    runId: RunId,
    terminal: RunTerminalState,
    /** The attempt landing this terminal; REQUIRED, see {@link RunAttemptFence}. */
    fence: RunAttemptFence,
    metrics?: RunMetrics,
  ): Promise<SettleAgentRunResult>;
  /**
   * Deliberate unfenced maintenance append, reachable ONLY by naming it.
   *
   * Optional so an implementation that has no maintenance path to offer does not
   * have to invent one; a caller that needs it on an implementation without it
   * gets a loud `undefined is not a function` rather than a silent downgrade to
   * the fenced method with a missing fence.
   */
  appendAgentRunEventsUnfenced?(
    runId: RunId,
    events: readonly RunEventEnvelope[],
    authorization: UnfencedRunWriteAuthorization,
  ): Promise<number>;
  /** The unfenced settle twin of {@link HostRunApiV1.settleAgentRun}. */
  settleAgentRunUnfenced?(
    runId: RunId,
    terminal: RunTerminalState,
    /** Required by the same rule as the fenced settle: never left off a list. */
    authorization: UnfencedRunWriteAuthorization,
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
  /**
   * Reasoning effort for this run (`low`/`medium`/`high`/`max`, plus whatever a
   * model's `reasoningEffortOptions` declares).
   *
   * A per-run override, not a session property: effort is what the user is
   * willing to pay for THIS message, and the Desktop composer already treats it
   * that way. Omitted means "the worker's default for this model".
   */
  readonly effort?: string;
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
  | {
      readonly requested: true;
      readonly runId: RunId;
      /**
       * The terminal the run reached, when the Host has one.
       *
       * The Host settles the run durably BEFORE it acknowledges the cancel,
       * so the terminal is known by the time the acknowledgement arrives.
       * Returning it saves the client a second round trip to learn how the
       * run ended — and how it ended is the difference between a turn the
       * user stopped and a turn that died, which a client that only sees
       * `requested` cannot tell apart.
       */
      readonly terminal?: RunTerminalState;
    }
  | { readonly requested: false; readonly runId: RunId; readonly reason: string };

/** One message the caller wants injected into a run that is already executing. */
export interface SteerAgentRunInput {
  readonly runId: RunId;
  /** The message text. Deliberately a string, not an items array: steering is a
   * user speaking into a running turn, not a batch of tool results. */
  readonly prompt: string;
  /**
   * The turn the caller believes is active.
   *
   * The Host REJECTS on mismatch rather than guessing which turn was meant.
   * Silently steering the wrong turn is worse than a refusal the caller can
   * retry: a refusal costs one round trip, a wrong-turn steer corrupts a
   * conversation the user can see.
   */
  readonly expectedTurnId?: string;
}

export type SteerAgentRunStage =
  | 'steered'
  | 'refused_run_not_found'
  | 'refused_run_settled'
  | 'refused_not_steerable'
  | 'refused_turn_mismatch'
  | 'refused_dispatch_failed';

/**
 * How a caller should treat a refusal.
 *
 * ## Why this is in the contract and not in each client
 *
 * Steer refusal is where the two clients used to diverge. A client that queued
 * refused steers BEHIND ordinary follow-ups would let a refused steer starve
 * and never be retried; one that retried everything would replay a steer the
 * run can no longer accept. Both are silent — the user's message just never
 * arrives, with no error anywhere.
 *
 * Putting the policy here means Electron and the CLI read the same field
 * instead of each re-deriving it from a stage string.
 */
export type SteerAgentRunRetry =
  /** The run is busy or not yet steerable; keep the steer and retry after it settles. */
  | 'after_settle'
  /** The caller named the wrong turn; re-read the active turn and retry once. */
  | 'with_current_turn'
  /** Never retry: the run is gone or the steer can never apply. */
  | 'never';

export type SteerAgentRunResult =
  | { readonly accepted: true; readonly runId: RunId; readonly stage: 'steered'; readonly turnId?: string }
  | {
      readonly accepted: false;
      readonly runId: RunId;
      readonly stage: Exclude<SteerAgentRunStage, 'steered'>;
      readonly reason: string;
      readonly retry: SteerAgentRunRetry;
    };

/**
 * Authenticated Host boundary for STARTING, STEERING and CANCELLING real runs.
 *
 * The ledger API above records what happened; this API makes the Host the
 * execution owner: a caller that can reach it can start a run the Host
 * supervises (worker dispatch, durable events, terminal settlement) and stop
 * one, without hosting any execution itself.
 */
export interface HostRunExecutionApiV1 {
  startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult>;
  cancelAgentRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult>;
  /** Optional process-local stream for protocol events not written to the ledger. */
  watchLiveAgentRunEvents?(
    runId: RunId,
    query?: AgentRunEventStreamQuery,
  ): AsyncIterable<RunEventEnvelope> | null;
  /**
   * Follow in-memory events from an active Host-owned run. Ephemeral deltas
   * are intentionally excluded from the durable event ledger and are exposed
   * only through this optional live stream.
   */
  watchLiveAgentRunEvents?(
    runId: RunId,
    query?: AgentRunEventStreamQuery,
  ): AsyncIterable<RunEventEnvelope> | null;
  /**
   * Inject a message into a run that is already executing.
   *
   * ## Why this is optional
   *
   * Every client already has a correct answer when steering is unavailable:
   * queue the message as the next turn. Steering is an enhancement, not a
   * capability the run lifecycle depends on, so requiring it here would force
   * every Host implementation to write a method most of them cannot honour.
   *
   * ## What a caller MUST do when it is absent
   *
   * Treat absence the way `after_settle` behaves — keep the message and retry
   * once the run settles. **Do not drop it, and do not report success.** A
   * message the user typed that silently disappears is the one failure mode
   * worse than an error, because the transcript looks identical to a delivered
   * one.
   */
  steerAgentRun?(input: SteerAgentRunInput): Promise<SteerAgentRunResult>;
}
