/** Compatibility exports; the bound task tool and execution live in Host. */
import { getBuiltInAgents } from '@duya/host/worker-subagents/built-in-agents';
import type { AgentDefinition } from './loadAgentsDir.js';

export { SubagentTool } from '@duya/host/worker-subagents/bound-tool';
export type { SubagentToolInput } from '@duya/capabilities/SubagentTool';
export {
  LEGACY_SUBAGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
  SUBAGENT_TOOL_NAME,
  VERIFICATION_AGENT_TYPE,
} from '@duya/capabilities/SubagentTool/constants';
export { formatAgentLine, formatAgentLineForPrompt, getPrompt } from './prompt.js';

export function getAgentDefinitions(): AgentDefinition[] {
  return getBuiltInAgents();
}
