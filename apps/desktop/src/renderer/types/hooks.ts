// Hook wire types shared between the stream-session-manager and the
// chat-tools renderer (plan 437).
//
// Hook events flow: agent core \u2192 SSE chat:agent_progress (type='hook_invoked')
// \u2192 stream-session-manager.handleAgentProgressEvent \u2192 StreamingEvent
// { type: 'hook_invocation' } \u2192 useStreamingActions \u2192 ActionItem
// { kind: 'hook', hook } \u2192 HookActionRow. The shape below is the canonical
// contract used by every link.

/** Hook executor type. Mirrors `HookCommand['type']` from the agent. */
export type HookExecutorType =
  | 'command'
  | 'process'
  | 'prompt'
  | 'http'
  | 'agent';

/** Outcome of one hook dispatch. Coarse enough for the row status dot. */
export type HookStatus = 'ok' | 'error' | 'timeout' | 'skipped';

/**
 * One row in the chat flow that mirrors the tool-use row UX. The
 * collapsed chrome shows the hook event name + hook name; the expanded
 * card shows the actual `additionalContext` (or verifier diagnostic,
 * or async task id, or error message) that the agent received.
 */
export interface HookAction {
  /** Stable per-round id; falls back to `seq` when the agent didn't mint one. */
  id: string;
  /** Hook lifecycle event (e.g. `PreToolUse`). Drives the row label. */
  hookEventName: string;
  /** Executor type — command / process / prompt / http / agent. */
  hookType: HookExecutorType;
  /** Truncated command line / URL / prompt summary. */
  hookName: string;
  /** Optional matcher pattern that fired. */
  matcher?: string;
  /** additionalContext the hook returned to the agent. */
  additionalContext?: string;
  /** Non-zero exit code for verifier hooks. */
  exitCode?: number;
  /** True for `async: true` command hooks. */
  async: boolean;
  /** Background task id (async hooks only). */
  backgroundTaskId?: string;
  /** Wall-clock duration of the hook execution in ms. */
  durationMs: number;
  /** Coarse outcome used by the status dot. */
  status: HookStatus;
  /** Failure reason (status !== 'ok'). */
  errorMessage?: string;
  /** Per-dispatch sequence for in-round ordering. */
  seq: number;
  /** Tool name when the hook is tool-scoped. */
  toolName?: string;
  /** Associated tool_use_id when tool-scoped. */
  toolUseId?: string;
}