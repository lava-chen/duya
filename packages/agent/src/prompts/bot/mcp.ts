/**
 * botMCP — MCP capability section for the bot prompt (Plan 474 P2.6).
 *
 * Mirrors grok-bot's `mcpCustomInstructionsSection` + `mcpDiscoveryStatusSection`
 * by rendering the MCP capability directory for this bot session.
 *
 * Data source: ctx.mcpTools (readonly Tool[] — filtered to MCP-owned tools,
 * passed in from DuyaAgent._buildSystemPrompt via loadBotPromptContext).
 *
 * The capability directory is deterministic and byte-for-byte stable while the
 * toolset is unchanged (sorted servers × sorted tool names, fixed caps).
 * This stability feeds the provider prompt-cache prefix (Plan 480 §8.8).
 *
 * grok-bot parity:
 * ✅ MCP server directory (name, source, tool count, sample tools)
 * ✅ `tool_schema` / `tool_search` / `tool_invoke` entry point guidance
 * ✅ Incomplete/warming annotation when discovery is still converging
 * ✅ Per-server tool truncation with "+N more" suffix
 * ✅ Bounded total character budget
 *
 * Note: grok-bot also has `getCustomInstructions()` per MCP server.
 * Duya's MCP client does not yet expose per-server custom instructions,
 * so this section renders only the capability directory.
 */

import type { Tool } from '../../types.js'
import type { BotPromptContext } from './framework.js'
import { buildMCPCapabilityCatalog } from '../../mcp/capability-catalog.js'

/** Budget: 2000 chars (MCP section can be a bit longer). */
const BOT_MCP_BUDGET_CHARS = 2000

export function renderBotMCP(ctx: BotPromptContext): string | null {
  const tools = ctx.mcpTools
  if (!tools || tools.length === 0) return null

  // Render the capability catalog with the full budget.
  const catalog = buildMCPCapabilityCatalog(tools, {
    maxServers: 12,
    maxToolsPerServer: 4,
    maxTotalChars: BOT_MCP_BUDGET_CHARS,
    // Use tool_search as the entry point (duya's default; catalog
    // exposure mode is handled separately in the system prompt).
    entryPoint: 'tool_search',
  })

  if (!catalog) return null

  return catalog
}
