/**
 * AgentTool utilities
 */

import type { Tool } from '../../types.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tool[]
  allowedAgentTypes?: string[]
}

/**
 * Filter tools based on agent definition
 */
export function filterToolsForAgent({
  tools,
}: {
  tools: Tool[]
}): Tool[] {
  return tools.filter((_tool: Tool) => {
    // Allow all tools for now
    // In a full implementation, this would filter based on tool permissions
    return true
  })
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source'
  >,
  availableTools: Tool[],
): ResolvedAgentTools {
  const { tools: agentTools, disallowedTools } = agentDefinition

  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(disallowedTools ?? [])

  // Filter available tools based on disallowed list
  const allowedAvailableTools =
    availableTools.filter((tool: Tool) => !disallowedToolSet.has(tool.name))

  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')

  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const toolSpec of agentTools ?? []) {
    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolSpec === AGENT_TOOL_NAME) {
      // For now, skip agent tool resolution
      validTools.push(toolSpec)
      continue
    }

    const tool = availableToolMap.get(toolSpec)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

export const AGENT_TOOL_NAME = 'Agent'
