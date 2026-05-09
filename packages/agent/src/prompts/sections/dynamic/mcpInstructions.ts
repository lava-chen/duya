/**
 * MCP Instructions Section - MCP Server Instructions
 */

import type { PromptContext } from '../../types.js'

export async function getMcpInstructionsSection(
  ctx: PromptContext,
): Promise<string | null> {
  if (!ctx.mcpServers || ctx.mcpServers.length === 0) {
    return null
  }

  const connectedServers = ctx.mcpServers.filter(
    (server): server is { name: string; instructions?: string } =>
      'instructions' in server && server.instructions !== undefined,
  )

  if (connectedServers.length === 0) {
    return null
  }

  const instructionBlocks = connectedServers
    .map(server => {
      return `## ${server.name}
${server.instructions}`
    })
    .join('\n\n')

  return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
}
