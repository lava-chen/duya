/**
 * Error taxonomy. Retryability is a WIRE value, not a client-side guess.
 *
 * The lesson behind this file is grok-build's `TURN_ACTIVE` / `is_turn_active()`
 * (02-reference-repo-boundaries.md:293-301): a client that has to import the
 * server's error enum to classify a failure has lost the ability to evolve
 * either side. So retryability ships as part of the code.
 *
 * Two booleans in the current codebase are being replaced by this:
 *   - `SSEEvent.error.metadata.isRetryable`  (ai/src/types.ts:177)
 *   - `Session.errorRetryable`                (apps/desktop/src/main/agents/server/types.ts:22)
 * Both are computed by the WRITER, which is exactly why they are untrustworthy
 * under version skew. Live proof: the router hardcodes `failSession(..., true)`
 * on every error path today.
 */

import type { DiagnosticDetail } from './primitives.js';

export const ERROR_CODES = [
  // request / negotiation
  'invalid_request',
  'invalid_manifest',
  'invalid_resume_point',
  'replay_unavailable',
  'unsupported_protocol_version',
  'unknown_method',
  'invalid_event_frame',
  'unknown_event_type',
  // lifecycle
  'run_not_found',
  'session_not_found',
  'run_active',
  'run_terminal',
  'cancel_conflict',
  // permission
  'permission_unknown_request',
  'permission_expired',
  'permission_denied_by_policy',
  // capability
  'capability_unsupported',
  'capability_not_ready',
  'manifest_mismatch',
  // transport / runtime
  'transport_closed',
  'transport_backpressure_timeout',
  'runtime_unavailable',
  'runtime_crash',
  'worker_spawn_failed',
  // budget
  'budget_exhausted',
  'deadline_exceeded',
  // provider
  'provider_rate_limited',
  'provider_auth',
  'provider_quota',
  'provider_overloaded',
  'provider_bad_request',
  'provider_timeout',
  'provider_unavailable',
  // execution
  'tool_failed',
  'tool_timeout',
  'tool_crash',
  'compaction_failed',
  'checkpoint_failed',
  'persistence_failed',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/**
 * Codes a client may retry without operator intervention.
 *
 * Deliberately small. Adding a code here is a promise to every host, not a
 * local convenience.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'provider_rate_limited',
  'provider_overloaded',
  'provider_timeout',
  'provider_unavailable',
  'transport_closed',
  'runtime_unavailable',
  'deadline_exceeded',
]);

/**
 * Codes after which the run is finished and a retry is a NEW run.
 *
 * drift test #6 asserts these two sets partition ERROR_CODES and are
 * disjoint, so a code can never be simultaneously "retry this" and "give up".
 */
export const TERMINAL_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'invalid_request',
  'invalid_manifest',
  'invalid_resume_point',
  'replay_unavailable',
  'unsupported_protocol_version',
  'unknown_method',
  'invalid_event_frame',
  'unknown_event_type',
  'run_not_found',
  'session_not_found',
  'run_active',
  'run_terminal',
  'cancel_conflict',
  'permission_unknown_request',
  'permission_expired',
  'permission_denied_by_policy',
  'capability_unsupported',
  'capability_not_ready',
  'manifest_mismatch',
  'worker_spawn_failed',
  'budget_exhausted',
  'provider_auth',
  'provider_quota',
  'provider_bad_request',
  'tool_failed',
  'tool_timeout',
  'tool_crash',
  'compaction_failed',
  'checkpoint_failed',
  'persistence_failed',
  'internal',
]);

/**
 * Codes deliberately in NEITHER set.
 *
 * `runtime_crash` means the clean-cancel path was violated. `transport_backpressure_timeout`
 * is decided by the adapter's drain policy, not by the run. Neither is a
 * statement about whether the RUN can proceed, so neither may be classified as
 * retryable or terminal by the protocol.
 */
export const UNCLASSIFIED_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'runtime_crash',
  'transport_backpressure_timeout',
]);

/** Unknown code → false. Failing closed is correct: the alternative is
 *  retrying forever against a code nobody has ever seen. */
export function isRetryable(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code as ErrorCode);
}

export function isKnownCode(code: string): code is ErrorCode {
  return ERROR_CODE_SET.has(code);
}

export function isTerminal(code: string): boolean {
  if (isRetryable(code)) return false;
  if (UNCLASSIFIED_ERROR_CODES.has(code as ErrorCode)) return false;
  return TERMINAL_ERROR_CODES.has(code as ErrorCode);
}

/**
 * Where a failure came from, and the producer's own code for it.
 *
 * ## The boundary rule
 *
 * `ErrorCode` is a closed set for the PROTOCOL/RUN boundary only — the failures
 * a host must be able to branch on without knowing anything about the provider,
 * the tool, or the connector. It is not a registry of every string this
 * repository emits, and it must not become one.
 *
 * The code that actually failed says something specific and useful:
 * `connector_auth_required`, `http_503`, `provider_error`, `cron_not_found`,
 * `slack_error`, and thirty more in the same shape. Folding those into
 * `ErrorCode` would mean a set that changes every time a connector gains an
 * error, and a host that has to upgrade to understand why a run failed.
 *
 * So the protocol code is the category and `cause` is the receipt. The cause's
 * `code` is a free string ON PURPOSE: it is preserved for diagnosis and must
 * never be branched on. The moment a host switches on `cause.code`, the
 * boundary this type exists to hold has been crossed.
 */
export type ErrorCauseSystem =
  | 'provider'
  | 'tool'
  | 'connector'
  | 'http'
  | 'runtime'
  | 'control_plane';

export interface ErrorCause {
  readonly system: ErrorCauseSystem;
  /**
   * The producer's own code, verbatim and untranslated. Free string by design.
   * Preserved for diagnosis; never a branch condition.
   */
  readonly code: string;
  /** HTTP status, when `system` is `http` or the producer reported one. */
  readonly status?: number;
  /** Diagnostic facts only. Never the offending payload. */
  readonly detail?: DiagnosticDetail;
}

export interface ProtocolErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  /** Diagnostic facts only — counts, durations, capability names.
   *  Never the offending payload: see `DiagnosticDetail`. */
  readonly details?: DiagnosticDetail;
  /**
   * The originating system's code, when the protocol code is a category rather
   * than the specific failure. See `ErrorCause`.
   */
  readonly cause?: ErrorCause;
  /** First-class field, never regex-scraped out of `message`.
   *  Today `retryAfterMs` is not expressed at all. */
  readonly retryAfterMs?: number;
}

export type WireResult<T> = { readonly ok: T } | { readonly err: ProtocolErrorInfo };

/** Thrown only by the strict validation path (`codecs.validate`), never by the
 *  decode path. Decode returns `UnknownRunEvent` for anything it does not
 *  recognise. */
export class ProtocolError extends Error {
  readonly info: ProtocolErrorInfo;

  constructor(info: ProtocolErrorInfo) {
    super(`${info.code}: ${info.message}`);
    this.name = 'ProtocolError';
    this.info = info;
  }

  get code(): ErrorCode {
    return this.info.code;
  }

  get retryable(): boolean {
    return isRetryable(this.info.code);
  }
}

export const ok = <T>(value: T): WireResult<T> => ({ ok: value });
export const err = (
  code: ErrorCode,
  message: string,
  extra?: Omit<ProtocolErrorInfo, 'code' | 'message'>,
): WireResult<never> => ({ err: { code, message, ...extra } });
