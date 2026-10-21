/**
 * SubagentTool exports
 *
 * Re-exports the renamed SubagentTool class, its types, and all
 * related utilities. External consumers should import from this
 * barrel rather than the individual files. The wire name of the
 * tool (`'Agent'`) is preserved — see `SUBAGENT_TOOL_NAME` in
 * `./constants.ts`.
 */

export { SUBAGENT_TOOL_NAME, LEGACY_SUBAGENT_TOOL_NAME, VERIFICATION_AGENT_TYPE, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js'
export { getAgentDefinitions, formatAgentLineForPrompt, getPrompt, formatAgentLine, SubagentTool } from './SubagentTool.js'
export type { SubagentToolInput } from './SubagentTool.js'
export { getBuiltInAgents } from './builtInAgents.js'
export type { AgentDefinition, BaseAgentDefinition, BuiltInAgentDefinition, CustomAgentDefinition, AgentDefinitionsResult, AgentMcpServerSpec } from './loadAgentsDir.js'
export { isBuiltInAgent, isCustomAgent, getActiveAgentsFromList, hasRequiredMcpServers, filterAgentsByMcpRequirements } from './loadAgentsDir.js'
export { isForkSubagentEnabled, FORK_SUBAGENT_TYPE, FORK_AGENT, buildForkedMessages, buildChildMessage, buildWorktreeNotice, buildWorktreeSpawnNotice } from './forkSubagent.js'
export { runAgent } from './runAgent.js'
export type { RunAgentParams, RunAgentResult, CacheSafeParams, AgentProgressEvent, SubagentRunDeps, CreateSubAgent, CreateToolRegistry } from './runAgent.js'
export { resolveResumeTarget } from './resumeAgent.js'
export type { ResumeTarget, ResumeTargetError, ResumeErrorCode } from './resumeAgent.js'
export { createIsolatedWorktree, slugifyWorktreeName, WorktreeError } from './worktree.js'
export type { IsolatedWorktree, WorktreeErrorCode } from './worktree.js'
export {
  buildSubagentResult,
  serializeSubagentResult,
  subagentToolResultSchema,
  normalizeEffort,
  normalizePermissionMode,
  normalizeToolOverlay,
  SUBAGENT_RUN_STATUSES,
  SUBAGENT_PERMISSION_MODES,
  SUBAGENT_EFFORT_LEVELS,
} from './subagentResult.js'
export type { SubagentToolResultPayload, SubagentRunStatus, SubagentToolOverlay, SubagentPermissionMode, SubagentEffort } from './subagentResult.js'
export { filterToolsForAgent, resolveAgentTools } from './subagentToolUtils.js'
export type { ResolvedAgentTools } from './subagentToolUtils.js'
