import type { ToolUseContext } from '../worker-run-contracts.js';
import type { AgentDefinition as CoreDefinition, BuiltInAgentDefinition as CoreBuiltIn, AgentDefinitionsResult as CoreResult } from '@duya/agent-core/subagents/agent-definition';
type PromptContext = Pick<ToolUseContext, 'options'>;
export type AgentDefinition = CoreDefinition<PromptContext>;
export type BuiltInAgentDefinition = CoreBuiltIn<PromptContext>;
export type AgentDefinitionsResult = CoreResult<PromptContext>;
export type { BaseAgentDefinition, CustomAgentDefinition, AgentMcpServerSpec } from '@duya/agent-core/subagents/agent-definition';
export { isBuiltInAgent, isCustomAgent, getActiveAgentsFromList, hasRequiredMcpServers, filterAgentsByMcpRequirements } from '@duya/agent-core/subagents/agent-definition';
