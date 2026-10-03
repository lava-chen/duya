/**
 * The error taxonomy: six categories, and what a caller is supposed to DO.
 *
 * ## Why the protocol's `ErrorCode` is not enough
 *
 * `@duya/agent-protocol` has 49 `ErrorCode` values and they are the right
 * granularity for a wire receipt. They are the wrong granularity for a CALLER
 * deciding whether to retry, because the decision does not depend on which
 * provider failed -- it depends on which LAYER refused. `provider_rate_limited`
 * and `provider_overloaded` are different codes with the same answer ("retry,
 * with a delay"), and `run_not_found` and `invalid_manifest` are different
 * codes with the same answer ("stop, a human has to look").
 *
 * So this file adds the one axis the wire codes deliberately do not carry, and
 * it is an axis a host can branch on WITHOUT importing the protocol package's
 * error enum -- which is the mistake `02-reference-repo-boundaries.md:293-301`
 * records about grok-build's `TURN_ACTIVE` and which `errors.ts` exists to
 * avoid repeating.
 *
 * ## The six categories are the plan's, and each has a distinct caller action
 *
 * A taxonomy is only worth having if every category implies a DIFFERENT
 * response. If two categories produced the same advice it would be one category
 * with a longer name. So the test at the bottom of this file asserts that: five
 * distinct actions across six categories, and every `ErrorCode` in the protocol
 * maps to exactly one of them.
 *
 *  - `protocol_invalid` -- the peer sent something unparseable or
 *    schema-violating. Retrying the same bytes reproduces it, so the answer is
 *    to STOP and report; a retry policy here is a loop that never terminates.
 *  - `policy_denied` -- permission or a host policy refused. This is a
 *    DECISION, not a failure. Retrying the identical request is a policy
 *    bypass attempt, so the answer is to stop and surface the decision.
 *  - `model_tool_error` -- the model or a tool failed. The run's own semantics
 *    say whether to retry, and the answer is genuinely conditional, which is
 *    why it is the one category whose policy is a function of the code.
 *  - `runtime_crash` -- the executor died without a clean stop. The run cannot
 *    continue and must not be reported as complete.
 *  - `persist_failure` -- storage refused the write. The events are real and
 *    the ledger has them, but durability is broken, so the run is not
 *    trustworthy even though it looks alive.
 *  - `replay_unavailable` -- the requested history is outside the window. The
 *    answer is a snapshot resync, which is neither "retry" nor "give up", and
 *    collapsing it into a plain error is what makes a consumer keep a
 *    transcript it never received.
 */

/** The six categories plan 587 T3.5 requires. */
export type TransportErrorCategory =
  | 'protocol_invalid'
  | 'policy_denied'
  | 'model_tool_error'
  | 'runtime_crash'
  | 'persist_failure'
  | 'replay_unavailable';

/**
 * What a caller should do, stated as an action rather than a mood.
 *
 * `resync` is a category of its own because it is the only outcome that tells
 * the caller to REPLACE state it already has. Every other outcome either
 * leaves state alone (`retry`, `retry_with_backoff`) or ends the run
 * (`stop`).
 */
export type CallerAction =
  | 'stop'
  | 'retry'
  | 'retry_with_backoff'
  | 'resync'
  | 'report_to_operator';

export interface TransportErrorPolicy {
  readonly category: TransportErrorCategory;
  readonly action: CallerAction;
  /**
   * Whether the SAME request may be reissued unchanged.
   *
   * False for `protocol_invalid` and `policy_denied`, and that is the load-
   * bearing field: both are reproducible, so a retry policy that reissues them
   * is a loop with a delay in it.
   */
  readonly sameRequestRetryable: boolean;
  /** Whether the run may still be reported as successful. Only `model_tool_error` may. */
  readonly runMayStillSucceed: boolean;
  /** One line an operator can act on. */
  readonly guidance: string;
}

const POLICIES: Readonly<Record<TransportErrorCategory, TransportErrorPolicy>> = {
  protocol_invalid: {
    category: 'protocol_invalid',
    action: 'stop',
    sameRequestRetryable: false,
    runMayStillSucceed: false,
    guidance:
      'The peer produced a frame that is not admissible. Re-sending the same bytes reproduces it; ' +
      'capture the raw frame and treat the producer as buggy.',
  },
  policy_denied: {
    category: 'policy_denied',
    action: 'stop',
    sameRequestRetryable: false,
    runMayStillSucceed: false,
    guidance:
      'A decision refused the request. This is an answer, not a fault: surface the decision to the ' +
      'user rather than reissuing it.',
  },
  model_tool_error: {
    category: 'model_tool_error',
    action: 'retry_with_backoff',
    sameRequestRetryable: true,
    runMayStillSucceed: false,
    guidance:
      'The model or a tool failed. Retry within the budget, and never reissue a tool call whose ' +
      'side effects are unknown.',
  },
  runtime_crash: {
    category: 'runtime_crash',
    action: 'report_to_operator',
    sameRequestRetryable: false,
    runMayStillSucceed: false,
    guidance:
      'The executor died without a clean stop. Do not report the run as complete; a new run is ' +
      'required and the old one is not resumable.',
  },
  persist_failure: {
    category: 'persist_failure',
    action: 'report_to_operator',
    sameRequestRetryable: false,
    runMayStillSucceed: false,
    guidance:
      'Durable storage refused a write. The events exist in memory but the run is no longer ' +
      'trustworthy, so the run is closed rather than continued.',
  },
  replay_unavailable: {
    category: 'replay_unavailable',
    action: 'resync',
    sameRequestRetryable: false,
    runMayStillSucceed: true,
    guidance:
      'The requested history is outside the window. Replace local state from the snapshot and ' +
      'resume from the seq the receipt reports -- do not append.',
  },
};

export function errorPolicy(category: TransportErrorCategory): TransportErrorPolicy {
  return POLICIES[category];
}

export const TRANSPORT_ERROR_CATEGORIES: readonly TransportErrorCategory[] = Object.freeze(
  Object.keys(POLICIES) as TransportErrorCategory[],
);

/**
 * The codes that mean "the protocol itself was violated", as distinct from
 * "the run failed for a reason inside it".
 *
 * ## Why `unknown_event_type` is here and NOT in `protocol_invalid`
 *
 * It is the one code in this group that is a legal forward-compatibility
 * outcome rather than a fault: an event type this build does not know is
 * carried as a typed extension and ignored, which is what the `extension.`
 * namespace exists for. Mapping it to `protocol_invalid` would make every
 * future event a hard failure and would make the forward-compatibility path
 * unreachable in practice.
 *
 * What decides it is the RESERVED-NAMESPACE rule T3.2 established, not the
 * code: an unknown `run.*` is a critical type this build cannot read, and that
 * is a refusal with `requiresTerminal`, not an extension. So the split between
 * "unknown but tolerable" and "unknown and terminal" is made by the
 * dispatcher, and this table only sees the codes that reached it.
 */
const PROTOCOL_INVALID_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_manifest',
  'invalid_resume_point',
  'unsupported_protocol_version',
  'unknown_method',
  'invalid_event_frame',
  'manifest_mismatch',
]);

const POLICY_DENIED_CODES: ReadonlySet<string> = new Set([
  'permission_denied_by_policy',
  'permission_expired',
  'permission_unknown_request',
  'budget_exhausted',
]);

const MODEL_TOOL_CODES: ReadonlySet<string> = new Set([
  'provider_rate_limited',
  'provider_auth',
  'provider_quota',
  'provider_overloaded',
  'provider_bad_request',
  'provider_timeout',
  'provider_unavailable',
  'tool_failed',
  'tool_timeout',
  'tool_crash',
  'compaction_failed',
  'deadline_exceeded',
]);

const RUNTIME_CRASH_CODES: ReadonlySet<string> = new Set([
  'runtime_crash',
  'runtime_unavailable',
  'worker_spawn_failed',
  'transport_closed',
  'transport_backpressure_timeout',
  'run_active',
  'run_terminal',
  'cancel_conflict',
  'run_not_found',
  'session_not_found',
  'capability_not_ready',
]);

const PERSIST_CODES: ReadonlySet<string> = new Set(['persistence_failed', 'checkpoint_failed']);

/**
 * Classify a wire code into the six categories.
 *
 * Total by construction and asserted by test: an unmapped code resolves to
 * `model_tool_error` (the conditional-policy bucket) rather than throwing,
 * because a host that cannot classify a new code must still be able to finish
 * the run. Falling back is safe here precisely because the fallback's policy is
 * the only one that is a function of the code rather than a fixed action.
 */
export function categoriseErrorCode(code: string): TransportErrorCategory {
  if (code === 'replay_unavailable') return 'replay_unavailable';
  if (code === 'capability_unsupported') return 'protocol_invalid';
  if (PROTOCOL_INVALID_CODES.has(code)) return 'protocol_invalid';
  if (POLICY_DENIED_CODES.has(code)) return 'policy_denied';
  if (PERSIST_CODES.has(code)) return 'persist_failure';
  if (RUNTIME_CRASH_CODES.has(code)) return 'runtime_crash';
  return 'model_tool_error';
}

/** The category plus the action it implies, in one call. */
export function explainError(code: string): TransportErrorPolicy {
  return errorPolicy(categoriseErrorCode(code));
}
