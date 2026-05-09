/**
 * Agent color management
 */

export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'

export const AGENT_COLORS: readonly AgentColorName[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const

// Map agent colors to theme color names
export const AGENT_COLOR_TO_THEME_COLOR: Record<AgentColorName, string> = {
  red: 'red_FOR_SUBAGENTS_ONLY',
  blue: 'blue_FOR_SUBAGENTS_ONLY',
  green: 'green_FOR_SUBAGENTS_ONLY',
  yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  purple: 'purple_FOR_SUBAGENTS_ONLY',
  orange: 'orange_FOR_SUBAGENTS_ONLY',
  pink: 'pink_FOR_SUBAGENTS_ONLY',
  cyan: 'cyan_FOR_SUBAGENTS_ONLY',
}

// In-memory color map (simplified - no persistence in duya yet)
const agentColorMap = new Map<string, AgentColorName>()

export function getAgentColor(agentType: string): AgentColorName | undefined {
  if (agentType === 'general-purpose') {
    return undefined
  }
  return agentColorMap.get(agentType)
}

export function setAgentColor(
  agentType: string,
  color: AgentColorName | undefined,
): void {
  if (!color) {
    agentColorMap.delete(agentType)
    return
  }

  if (AGENT_COLORS.includes(color)) {
    agentColorMap.set(agentType, color)
  }
}
