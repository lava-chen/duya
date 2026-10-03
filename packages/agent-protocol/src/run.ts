/**
 * The Run API: what a host gets back, and what cancel actually means.
 *
 * ## First writer of the terminal state wins
 *
 * The run state machine is `pending -> running -> completing -> terminal`, and
 * the terminal transition is a one-shot CAS. Everything below follows from that
 * single fact:
 *
 *  - `cancel()` after a terminal state returns `{ applied: false }` and does
 *    NOTHING. No throw, no re-send.
 *  - Exactly one of `run.completed` / `run.failed` is the last envelope.
 *  - Cancellation emits `run.completed`, never `run.failed`. Cancelling is not
 *    a failure.
 *  - Budget exhaustion, tool-error stop, natural completion, and cancellation
 *    COMPETE FOR THE SAME CAS. There is no priority between them, only arrival
 *    order. This is deliberate: any priority scheme would need a total order
 *    that the host may not yet have observed.
 *  - If `graceMs` expires and the transport must hard-kill, the run is
 *    `run.failed { code: 'runtime_crash', details: { escalated: true } }`.
 *    A hard kill means the clean cancel path was not honoured, and reporting
 *    `cancelled` would be a lie.
 *
 * `applied` is the improvement over `handleDeleteChat` (router.ts:1670), which
 * hard-migrates `STREAMING -> COMPLETED` in the DB BEFORE the worker acks
 * (:1681-1683) and returns `{ ok: true, interrupted: boolean }`. **A host today
 * cannot distinguish "I cancelled this" from "it had already ended".**
 */

import type { EventSource, RunEventEnvelope } from './envelope.js';
import type { RunManifest } from './manifest.js';
import type { ResumeRequest } from './resume.js';
import type { PermissionAck, PermissionResponse } from './permission.js';
import type { RuntimeCapabilities, ProbeOptions } from './capabilities.js';
import type { ErrorCode, ProtocolErrorInfo } from './errors.js';
import type { TokenUsage, StopReason, MessageContent, PausePoint } from './events/payloads.js';
import type { DiagnosticDetail, Millis, RunId, SessionId, TraceId } from './primitives.js';

export type RunInput = Readonly<Record<string, unknown>>;

export interface StartOptions {
  /** Replay from this seq. Equivalent to `Last-Event-ID` on HTTP. */
  readonly fromSeq?: number;
  readonly traceId?: TraceId;
  readonly signal?: AbortSignal;
}

export type CancelReason =
  | 'user'
  | 'budget'
  | 'tool_error'
  | 'permission_denied'
  | 'host_shutdown'
  | 'harness_abort';

/**
 * How a run ended.
 *
 * A discriminated union, not a bag of optionals. With `error?: ProtocolErrorInfo`
 * on a single object, `failed` without an error and `completed` with one are both
 * representable, and both are wrong. The failure code is the whole point of
 * knowing a run failed, so it is not optional on the failure arm and forbidden
 * on the others.
 */
export type RunTerminalState =
  | { readonly status: 'completed'; readonly stopReason?: StopReason }
  | { readonly status: 'cancelled'; readonly stopReason?: StopReason }
  | { readonly status: 'budget_exhausted'; readonly stopReason?: StopReason }
  | { readonly status: 'failed'; readonly error: ProtocolErrorInfo };

/**
 * How a stop actually ended.
 *
 * Three states, and the middle one is the whole point of the type. A caller that
 * only learns "the stop was requested" cannot tell a worker that closed its
 * stream cleanly from one that had to be killed, and the difference is the
 * difference between `cancelled` and `runtime_crash` in the durable receipt.
 *
 *  - `cooperative` — the executor acknowledged the stop and left inside the
 *    grace window. The clean-cancel path was honoured, and that is a fact.
 *  - `escalated` — the grace window expired and the platform adapter killed or
 *    fenced the process, OR the stop was never answered inside a bound. Both are
 *    the same claim: **there is no clean-exit evidence**, so the run must not be
 *    recorded as a cancellation that worked. A stop nobody answered is not a
 *    stop that succeeded quietly.
 *  - `unavailable` — there was no live executor to stop. The run's own history
 *    is the only evidence, and the caller has to read that instead.
 */
export type StopDisposition = 'cooperative' | 'escalated' | 'unavailable';

export interface CancelOutcome {
  /**
   * True when this call actually reached a live run and asked it to stop.
   *
   * Distinct from `applied`, and the pair is the answer to "did my stop do
   * anything?": `requested` is about the ask, `applied` is about the effect. A
   * host that reads only `applied` cannot tell a refused stop from a stop that
   * landed on a run that had already finished.
   */
  readonly requested: boolean;
  /** False means the run was already terminal and this call did nothing. */
  readonly applied: boolean;
  /**
   * What the stop turned into, when a stop was issued.
   *
   * Absent when no stop was needed — a run that had already reached its terminal
   * has no stop to describe, and inventing one would put a disposition in the
   * durable record for a kill that never happened.
   */
  readonly disposition?: StopDisposition;
  readonly terminal: RunTerminalState;
}

export interface RunMetrics {
  readonly eventsTotal: number;
  readonly eventsDurable: number;
  readonly eventsVolatile: number;
  /** Ephemeral events are COUNTED, never retained. A text_delta storm would
   *  otherwise consume the whole buffer. */
  readonly eventsEphemeral: number;
  readonly toolCalls: number;
  readonly permissionRequests: number;
  readonly wallClockMs: Millis;
}

export interface PermissionAuditEntry {
  readonly requestId: string;
  readonly action: string;
  readonly source: string;
  readonly latencyMs: Millis;
  readonly scopeKind?: string;
}

export interface RunResult {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly status: 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  readonly stopReason?: StopReason;
  readonly error?: ProtocolErrorInfo;
  readonly metrics: RunMetrics;
  /** Contains durable + volatile events ONLY. */
  readonly transcript: readonly RunEventEnvelope[];
  readonly permissionAudit: readonly PermissionAuditEntry[];
  readonly usage?: TokenUsage;
  readonly content?: readonly MessageContent[];
  readonly budgetUsed?: {
    readonly turns?: number;
    readonly toolCalls?: number;
    readonly tokens?: number;
  };
}

export interface RunHandle {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly manifest: RunManifest;
  /** Resolves exactly once. */
  readonly terminal: Promise<RunTerminalState>;
  /** The ONLY channel through which run state propagates. */
  events(): EventSource;
  respondToPermission(requestId: string, decision: PermissionResponse): Promise<PermissionAck>;
  /**
   * Ask the run to stop.
   *
   * `reason` is the closed vocabulary of WHAT sort of stop this is, and decides
   * nothing — `resolveRunOutcome` owns the rule that turns a stop into a
   * terminal. `opts.reason` is the free-text provenance that goes into the
   * durable record, because `CancelReason` cannot say which route asked: a user
   * pressing stop and a conversation being deleted are both `user`, and only the
   * second one explains a run that ended with nobody watching it.
   */
  cancel(
    reason?: CancelReason,
    opts?: { graceMs?: number; reason?: string },
  ): Promise<CancelOutcome>;
  pause(at?: PausePoint): Promise<void>;
  result(): Promise<RunResult>;
}

export interface AgentRuntimeApi {
  start(manifest: RunManifest, input: RunInput, opts?: StartOptions): Promise<RunHandle>;
  resume(manifest: RunManifest, request: ResumeRequest, input?: RunInput): Promise<RunHandle>;
  probe(opts?: ProbeOptions): Promise<RuntimeCapabilities>;
  /** Synchronous, sourced from the hello/ready frame. */
  readonly capabilities: RuntimeCapabilities;
}

export type { ErrorCode };
