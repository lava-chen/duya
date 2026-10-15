/** Pure agent-definition vocabulary and selection helpers. */

export type AgentMcpServerSpec =
  | string
  | { [name: string]: { command: string; args?: string[]; env?: Record<string, string> } };

export type BaseAgentDefinition = {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: AgentMcpServerSpec[];
  color?: string;
  model?: string;
  maxTurns?: number;
  filename?: string;
  baseDir?: string;
  background?: boolean;
  initialPrompt?: string;
  requiredMcpServers?: string[];
  mcpTools?: boolean;
  omitClaudeMd?: boolean;
};

export type BuiltInAgentDefinition<TPromptContext = unknown> = BaseAgentDefinition & {
  source: 'built-in';
  baseDir: 'built-in';
  callback?: () => void;
  getSystemPrompt: (params: { toolUseContext: TPromptContext }) => string;
};

export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string;
  source: 'userSettings' | 'projectSettings';
  filename?: string;
  baseDir?: string;
};

export type AgentDefinition<TPromptContext = unknown> =
  | BuiltInAgentDefinition<TPromptContext>
  | CustomAgentDefinition;

export function isBuiltInAgent<TPromptContext>(
  agent: AgentDefinition<TPromptContext>,
): agent is BuiltInAgentDefinition<TPromptContext> {
  return agent.source === 'built-in';
}

export function isCustomAgent<TPromptContext>(
  agent: AgentDefinition<TPromptContext>,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in';
}

export type AgentDefinitionsResult<TPromptContext = unknown> = {
  activeAgents: AgentDefinition<TPromptContext>[];
  allAgents: AgentDefinition<TPromptContext>[];
  failedFiles?: Array<{ path: string; error: string }>;
  allowedAgentTypes?: string[];
};

/** Apply built-in, then user, then project precedence while preserving order. */
export function getActiveAgentsFromList<T extends {
  agentType: string;
  source: 'built-in' | 'userSettings' | 'projectSettings';
}>(allAgents: T[]): T[] {
  const groups: T[][] = [
    allAgents.filter((agent) => agent.source === 'built-in'),
    allAgents.filter((agent) => agent.source === 'userSettings'),
    allAgents.filter((agent) => agent.source === 'projectSettings'),
  ];
  const byType = new Map<string, T>();
  for (const group of groups) {
    for (const agent of group) byType.set(agent.agentType, agent);
  }
  return Array.from(byType.values());
}

export function hasRequiredMcpServers(
  agent: Pick<BaseAgentDefinition, 'requiredMcpServers'>,
  availableServers: string[],
): boolean {
  const requirements = agent.requiredMcpServers;
  if (!requirements?.length) return true;
  return requirements.every((pattern) =>
    availableServers.some((server) => server.toLowerCase().includes(pattern.toLowerCase())),
  );
}

export function filterAgentsByMcpRequirements<T extends Pick<BaseAgentDefinition, 'requiredMcpServers'>>(
  agents: T[],
  availableServers: string[],
): T[] {
  return agents.filter((agent) => hasRequiredMcpServers(agent, availableServers));
}
