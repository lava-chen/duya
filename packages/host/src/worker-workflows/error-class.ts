/**
 * error-class.ts — failure taxonomy for workflow node errors
 * (plan 552 §4.4 / §5 落点④; Skyvern-style classes, regex first —
 * the Jev choice 归因 upgrade rides in later via DecisionService).
 *
 * The class drives the dynamic on_error policy: retryable classes may
 * consume `max_retries`; the rest fail or skip immediately.
 */

export type WorkflowErrorClass =
  | 'approval_denied'
  | 'approval_timeout'
  | 'transient'
  | 'timeout'
  | 'tool_missing'
  | 'agent_missing'
  | 'tool_error'
  | 'schema_mismatch'
  | 'expr_error'
  | 'decision_unavailable'
  | 'suspended'
  | 'budget_exceeded'
  | 'cancelled'
  | 'unknown';

/** Classes worth another attempt (dynamic retry policy, §5 落点④). */
export const RETRYABLE_CLASSES: ReadonlySet<WorkflowErrorClass> = new Set([
  'transient',
  'timeout',
  'tool_error',
  'unknown',
]);

const PATTERNS: ReadonlyArray<[RegExp, WorkflowErrorClass]> = [
  [/USER_REJECTED|APPROVAL_DENIED|denied by user/i, 'approval_denied'],
  // computer-use refusals-as-policy (plan 454): APP_BLOCKED / REDACTED_FIELD / BLOCKED.
  [/APP_BLOCKED|REDACTED_FIELD|\bBLOCKED\b/i, 'approval_denied'],
  [/APPROVAL_TIMEOUT|approval timed out/i, 'approval_timeout'],
  [/rate.?limit|429|503|ECONNRESET|ETIMEDOUT|socket hang up|overloaded/i, 'transient'],
  [/timed? ?out|deadline exceeded/i, 'timeout'],
  [/unknown tool|not registered|tool_missing/i, 'tool_missing'],
  [/unknown agent|agent not found/i, 'agent_missing'],
  [/schema mismatch|failed schema validation|output_schema/i, 'schema_mismatch'],
  [/ExprError|unresolvable reference/i, 'expr_error'],
  [/DecisionUnavailable|decision backend/i, 'decision_unavailable'],
  [/BudgetExceeded|budget exceeded/i, 'budget_exceeded'],
  [/cancelled|aborted/i, 'cancelled'],
];

/** Regex-first classification of an error value. */
export function classifyError(err: unknown): WorkflowErrorClass {
  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : '';
  for (const [re, cls] of PATTERNS) {
    if (re.test(message)) return cls;
  }
  return 'unknown';
}

/** Marker error for a suspended (parked) branch — never journaled as a failure. */
export class SuspensionSignal extends Error {
  constructor(
    readonly nodeId: string,
    readonly waitTill: number,
    readonly reason: string,
  ) {
    super(`run suspended at ${nodeId}: ${reason}`);
    this.name = 'SuspensionSignal';
  }
}
