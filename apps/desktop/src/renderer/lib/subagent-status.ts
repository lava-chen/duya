// src/lib/subagent-status.ts
// Single source of truth for sub-agent run status across the renderer.
//
// Before this module the codebase carried three incompatible vocabularies:
//   - SubAgentRowInfo.status  (useSubAgentProgress.ts): waiting | running | completed | error
//   - ParsedSubAgentToolResult.status (subagent-result.ts): running | completed | failed
//   - agent-side TaskStatus (BackgroundAgentLifecycle.ts): pending | running | completed | killed | failed
// None of them could express "the user stopped it" as anything other than an
// error, so a cancelled sub-agent was indistinguishable from a crashed one.
// Everything renderer-side now derives from `SubagentRunStatus` here.

/**
 * Lifecycle status of one sub-agent run.
 *
 * `killed` is a first-class terminal state: `BackgroundAgentLifecycle.kill()`
 * already records it agent-side, and the UI must stop presenting a user-cancel
 * as a failure.
 */
export type SubagentRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed';

/** Terminal statuses never transition again. */
export const SUBAGENT_TERMINAL_STATUSES: ReadonlySet<SubagentRunStatus> = new Set<SubagentRunStatus>([
  'completed',
  'failed',
  'killed',
]);

export function isTerminalSubagentStatus(status: SubagentRunStatus): boolean {
  return SUBAGENT_TERMINAL_STATUSES.has(status);
}

/**
 * The subset of `AgentProgressEvent` needed to derive status. Declared
 * structurally so this module stays importable from tests and from components
 * that do not want the whole stream-session-manager surface.
 */
export interface SubagentStatusEventLike {
  type: string;
  /**
   * Optional agent-side reason. `BackgroundAgentLifecycle` writes
   * `killed: <reason>` into the error field, and a `done` event carrying
   * `data: 'killed: user_kill'` must resolve to `killed`, not `completed`.
   */
  data?: string;
}

/**
 * Map a raw status string (from any of the three legacy vocabularies, or from
 * the structured tool result) onto the shared vocabulary. Unknown values fall
 * back to `failed` when they clearly denote a terminal non-success state and
 * `pending` otherwise, so a malformed payload never renders as "running".
 */
export function normalizeSubagentStatus(value: unknown): SubagentRunStatus | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'running':
    case 'in_progress':
    // A background spawn receipt reports `async_launched` — the sub-agent is
    // alive but has not produced a result yet, so it is running, not done.
    case 'async_launched':
      return 'running';
    case 'pending':
    case 'waiting':
    case 'queued':
      return 'pending';
    case 'completed':
    case 'success':
    case 'succeeded':
    case 'done':
      return 'completed';
    case 'failed':
    case 'failure':
    case 'error':
      return 'failed';
    case 'killed':
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
      return 'killed';
    default:
      return undefined;
  }
}

/**
 * A kill that arrives over the progress channel is an `error` event whose data
 * carries the agent-side reason. Detect it before the generic error branch so
 * the UI can say "已停止" instead of "失败".
 */
function isKillPayload(data: string | undefined): boolean {
  if (!data) return false;
  return /^\s*killed\b/i.test(data);
}

/**
 * Derive status from the ordered progress events of a single sub-agent run.
 *
 * Pure and side-effect free: the last terminal event wins, which is what the
 * row, the side panel header and the task drawer all need. Returns `pending`
 * for an empty event list (the sub-agent has been spawned but has not reported
 * anything yet).
 */
export function deriveSubagentStatus(events: readonly SubagentStatusEventLike[]): SubagentRunStatus {
  if (events.length === 0) return 'pending';

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    switch (event.type) {
      case 'done':
        return isKillPayload(event.data) ? 'killed' : 'completed';
      case 'error':
        return isKillPayload(event.data) ? 'killed' : 'failed';
      case 'started':
      case 'heartbeat':
      case 'text':
      case 'thinking':
      case 'tool_use':
      case 'tool_result':
      case 'hook_invoked':
        return 'running';
      default:
        break;
    }
  }
  return 'pending';
}
