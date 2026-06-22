/**
 * SubagentTool Constants
 *
 * The wire name is still `'Agent'` for backward compat with:
 *   - existing session history (tool_use.name = 'Agent')
 *   - saved permission rules
 *   - claude-code alignment contract
 *
 * Renamed internally to `SubagentTool` to better signal intent to
 * the LLM (this spawns a *sub*-agent, not a top-level agent loop).
 */

export const SUBAGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions).
// Retained for the upcoming P0-γ split (TaskTool → BackgroundTask suite) — old
// sessions whose history used `Task` should continue to be handled correctly.
export const LEGACY_SUBAGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
