/**
 * packages/agent/src/mcp/mcpService.ts
 *
 * Domain reader for MCP servers.
 *
 * After the old MCP inventory framework was removed, the only export
 * kept here is `computeMCPId` — the canonical public id derivation
 * used by `capability-management/cross-source.ts` and the agent's
 * MCP loader to identify the same MCP server across sources.
 *
 * The previous precedence resolver (`resolveAvailableMCPs`) and the
 * DTO shapes (`MCPListItem` / `MCPInfoItem`) were only consumed by
 * the deleted `MCPInventoryService` and the CLI read endpoints
 * (`GET /v1/mcps`, `GET /v1/mcps/:id`). Worker-side
 * `applyMCPConfiguration` is now the single source of truth for the
 * effective MCP set, surfaced via the `mcp:status:snapshot` SSE
 * event and the capability-management snapshot.
 */

import type { MCPCandidate } from '@duya/plugin-core';

/**
 * Compute the public `id` for a candidate.
 *
 * The id is stable across reloads for the same (source, pluginId,
 * name) tuple. It is the key used by the capability-management
 * aggregator to join declared capabilities with the worker's loaded
 * MCP set.
 */
function idFor(c: MCPCandidate): string {
  const pluginId = c.pluginId;
  if (c.source === 'plugin' && pluginId) {
    return `plugin:${pluginId}:${c.rawConfig.name}`;
  }
  if (c.source === 'bundled') {
    return `bundled:${c.rawConfig.name}`;
  }
  return `settings:${c.rawConfig.name}`;
}

export { idFor as computeMCPId };
