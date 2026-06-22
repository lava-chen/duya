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
export { getSubagentToolDefinition, getAgentDefinitions, formatAgentLineForPrompt, getPrompt, formatAgentLine, subagentTool, SubagentTool } from './SubagentTool.js'
export type { SubagentToolInput, SubagentToolResult } from './SubagentTool.js'
export { getBuiltInAgents } from './builtInAgents.js'
export type { AgentDefinition, BaseAgentDefinition, BuiltInAgentDefinition, CustomAgentDefinition, AgentDefinitionsResult, AgentMcpServerSpec } from './loadAgentsDir.js'
export { isBuiltInAgent, isCustomAgent, getActiveAgentsFromList, hasRequiredMcpServers, filterAgentsByMcpRequirements } from './loadAgentsDir.js'
export { isForkSubagentEnabled, FORK_SUBAGENT_TYPE, FORK_AGENT, buildForkedMessages, buildChildMessage, buildWorktreeNotice } from './forkSubagent.js'
export { runAgent } from './runAgent.js'
export type { RunAgentParams, RunAgentResult, CacheSafeParams } from './runAgent.js'
export { resumeAgentBackground } from './resumeAgent.js'
export type { ResumeAgentResult } from './resumeAgent.js'
export { filterToolsForAgent, resolveAgentTools } from './subagentToolUtils.js'
export type { ResolvedAgentTools } from './subagentToolUtils.js'
