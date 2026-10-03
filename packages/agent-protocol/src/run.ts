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

/**
 * A result surface that is EITHER read, or declared unsupported.
 *
 * ## Why this is not an array
 *
 * `transcript: []` and `permissionAudit: []` were two different claims wearing
 * one value. An empty array says **this run produced nothing of this kind**,
 * which is a fact about the run. The runtime was using it to say **this runtime
 * does not implement reading this back**, which is a fact about the
 * implementation. A consumer reading the empty array drew the first conclusion
 * from the second, and the only reader that could tell them apart was the one
 * that already knew the answer.
 *
 * A security audit surface is where that swap costs the most. "No permission
 * activity was recorded" is a clean bill of health; "permission auditing is not
 * implemented here" means the clean bill was never looked for. They must not
 * share a value, so the two states are separate and both are spelled out:
 *
 *  - `read` — the entries are real and the reader below is the complete set
 *    this runtime could produce.
 *  - `unsupported` — the capability does not exist here. `reason` says which
 *    of the two causes it is, because "nobody asked" and "we cannot look" are
 *    different problems with different fixes.
 *
 * `unsupported` is the honest default and is not a placeholder. A surface that
 * exists but is empty is `read` with no entries; a surface that does not exist
 * is `unsupported`; and no future change may quietly turn the second into the
 * first.
 */
export type RunSurface<T> =
  | { readonly state: 'read'; readonly entries: readonly T[] }
  | { readonly state: 'unsupported'; readonly reason: string };

/**
 * A token total that is either measured, or explicitly not measured.
 *
 * ## Why `0` is not an answer
 *
 * Tokens arrive from provider usage events. A run that was cancelled before its
 * first model response, or whose executor reports no usage, has no token count
 * — and reporting `0` for that is a BILLING claim: it says the run consumed
 * nothing, which is a thing the runtime cannot know. A run that spent a large
 * context window and was then killed mid-request looks exactly like a run that
 * was never dispatched.
 *
 * So the unmeasured case carries no number at all, not a zero standing in for
 * one. `total` is structurally absent from the `measured: false` arm, so there
 * is no value to accidentally sum, average, or default. A distinct union rather
 * than a nullable because `null` invites `?? 0` at the first call site — which
 * is the exact collapse this type exists to prevent — and because a nullable
 * field cannot make a consumer handle the case at all.
 *
 * `turns` and `toolCalls` are NOT in this type and are plain numbers: both are
 * counted from events the runtime observed itself, so a zero for them is a
 * MEASURED zero rather than an absence.
 */
export type MeasuredTokens =
  | { readonly measured: true; readonly total: number }
  | {
      readonly measured: false;
      /** Structurally absent. There is no number to mistake for a measurement. */
      readonly total?: undefined;
      /** Why it is unknown, in one line. */
      readonly reason: string;
    };

/**
 * What a run actually spent.
 *
 * `tokens` is a {@link MeasuredTokens} and the other two are not, and the
 * asymmetry is the point: a turn and a tool call are things the runtime counts
 * as they are observed, while a token is something a provider has to report.
 *
 * ## What this does not prove
 *
 * A `maxTokens` ceiling is evaluated against this token count. When the count
 * is unmeasured, a verdict of "not exhausted" on the token axis means **not
 * measured to be over**, not **measured to be under**. That is the limit of what
 * an absent usage event can support, and the reason `tokens` refuses to become
 * `0` here rather than only in a report.
 */
export interface RunSpendReport {
  readonly turns: number;
  readonly toolCalls: number;
  readonly tokens: MeasuredTokens;
}

export interface RunResult {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly status: 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  readonly stopReason?: StopReason;
  readonly error?: ProtocolErrorInfo;
  readonly metrics: RunMetrics;
  /**
   * The run's events, or the statement that this runtime does not read them back.
   *
   * When `read`, the entries contain durable + volatile events ONLY.
   */
  readonly transcript: RunSurface<RunEventEnvelope>;
  /**
   * Every permission decision this run made, or the statement that this runtime
   * does not record them.
   *
   * A `read` with no entries is the strong claim: the run asked for nothing and
   * was refused nothing. `unsupported` is the weak one: nobody checked.
   */
  readonly permissionAudit: RunSurface<PermissionAuditEntry>;
  readonly usage?: TokenUsage;
  readonly content?: readonly MessageContent[];
  /** Never absent. A run reports what it spent, and says when it does not know. */
  readonly budgetUsed: RunSpendReport;
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
