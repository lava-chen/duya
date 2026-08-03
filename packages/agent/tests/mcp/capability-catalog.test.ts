import { describe, expect, it } from 'vitest';
import { buildMCPCapabilityCatalog } from '../../src/mcp/capability-catalog.js';
import type { Tool } from '../../src/types.js';

function mcpTool(
  serverName: string,
  toolName: string,
  source: NonNullable<Tool['mcpInfo']>['source'] = 'plugin',
): Tool {
  return {
    name: `mcp_${serverName}_${toolName}`,
    description: toolName,
    input_schema: { type: 'object' },
    mcpInfo: { serverName, toolName, source },
  };
}

describe('buildMCPCapabilityCatalog', () => {
  it('groups tools by connected server without exposing schemas', () => {
    const catalog = buildMCPCapabilityCatalog([
      mcpTool('notion', 'search_pages'),
      mcpTool('notion', 'create_page'),
      mcpTool('github', 'list_pull_requests', 'settings'),
    ]);

    expect(catalog).toContain('## MCP Capability Directory');
    expect(catalog).toContain('`notion` (plugin, 2 tools): search_pages, create_page');
    expect(catalog).toContain('`github` (user mcp.toml, 1 tools): list_pull_requests');
    expect(catalog).toContain('call `tool_search` with the server name');
    expect(catalog).not.toContain('input_schema');
  });

  it('returns an empty string when no MCP tools are connected', () => {
    expect(buildMCPCapabilityCatalog([])).toBe('');
  });
});
