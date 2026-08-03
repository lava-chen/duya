import type { Tool } from '../types.js';

const MAX_SERVERS = 12;
const MAX_TOOL_NAMES_PER_SERVER = 4;
const MAX_LABEL_LENGTH = 80;

type MCPSource = NonNullable<Tool['mcpInfo']>['source'];

interface CatalogServer {
  name: string;
  source: MCPSource;
  toolNames: string[];
}

function displaySource(source: MCPSource): string {
  switch (source) {
    case 'settings':
      return 'user mcp.toml';
    case 'plugin':
      return 'plugin';
    case 'bundled':
      return 'bundled';
    default:
      return 'external';
  }
}

function safeLabel(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

/**
 * Build a compact, schema-free directory of MCP capabilities for the first
 * model turn. Individual MCP schemas stay discoverable through tool_search;
 * this only tells the model which connected servers are worth searching.
 */
export function buildMCPCapabilityCatalog(tools: readonly Tool[]): string {
  const servers = new Map<string, CatalogServer>();

  for (const tool of tools) {
    const info = tool.mcpInfo;
    if (!info) continue;

    const key = `${info.source}:${info.serverName}`;
    const server = servers.get(key) ?? {
      name: safeLabel(info.serverName),
      source: info.source,
      toolNames: [],
    };
    const toolName = safeLabel(info.toolName);
    if (toolName && !server.toolNames.includes(toolName)) {
      server.toolNames.push(toolName);
    }
    servers.set(key, server);
  }

  const entries = [...servers.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
    .slice(0, MAX_SERVERS);
  if (entries.length === 0) return '';

  const lines = entries.map((server) => {
    const examples = server.toolNames.slice(0, MAX_TOOL_NAMES_PER_SERVER).join(', ');
    const remaining = server.toolNames.length - Math.min(server.toolNames.length, MAX_TOOL_NAMES_PER_SERVER);
    const suffix = remaining > 0 ? `, +${remaining} more` : '';
    return `- \`${server.name}\` (${displaySource(server.source)}, ${server.toolNames.length} tools): ${examples}${suffix}`;
  });
  const omitted = servers.size - entries.length;
  if (omitted > 0) lines.push(`- ${omitted} additional MCP server(s) omitted from this compact directory.`);

  return [
    '## MCP Capability Directory',
    '',
    'These MCP servers are connected for this task. Their full schemas are intentionally loaded on demand.',
    ...lines,
    '',
    'When an MCP capability is needed, call `tool_search` with the server name or the operation you need. Do not claim that a server is unavailable merely because its individual tools are not in the default tool list.',
  ].join('\n');
}
