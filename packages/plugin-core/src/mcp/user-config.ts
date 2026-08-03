import * as TOML from '@iarna/toml';

/**
 * The portable representation stored in DUYA's user-managed mcp.toml.
 * Plugin and bundled MCP declarations intentionally do not use this shape.
 */
export interface UserMcpTomlServer {
  name: string;
  transport?: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  allowedAgentIds?: string[];
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a table of string values`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.slice() as string[];
}

/** Parse the canonical `[mcp_servers.<name>]` TOML structure. */
export function parseUserMcpToml(text: string): UserMcpTomlServer[] {
  const parsed = TOML.parse(text) as Record<string, unknown>;
  const servers = parsed.mcp_servers;
  if (servers === undefined) return [];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('mcp_servers must be a table');
  }

  const result: UserMcpTomlServer[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`mcp_servers.${name} must be a table`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.enabled !== 'undefined' && typeof entry.enabled !== 'boolean') {
      throw new Error(`mcp_servers.${name}.enabled must be a boolean`);
    }
    const transport = entry.transport;
    if (transport !== undefined && transport !== 'stdio' && transport !== 'streamable-http') {
      throw new Error(`mcp_servers.${name}.transport must be stdio or streamable-http`);
    }
    result.push({
      name,
      transport: transport as UserMcpTomlServer['transport'],
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: stringArray(entry.args, `mcp_servers.${name}.args`),
      env: stringRecord(entry.env, `mcp_servers.${name}.env`),
      url: typeof entry.url === 'string' ? entry.url : undefined,
      headers: stringRecord(entry.headers, `mcp_servers.${name}.headers`),
      enabled: entry.enabled !== false,
      allowedAgentIds: stringArray(entry.allowed_agent_ids, `mcp_servers.${name}.allowed_agent_ids`),
    });
  }
  return result;
}

/** Serialize without secrets escaping into JSON, preserving a human-editable TOML file. */
export function stringifyUserMcpToml(servers: readonly UserMcpTomlServer[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      ...(server.transport ? { transport: server.transport } : {}),
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
      enabled: server.enabled !== false,
      ...(server.allowedAgentIds?.length ? { allowed_agent_ids: server.allowedAgentIds } : {}),
    };
  }
  return `# User-managed MCP servers for DUYA. Plugin MCPs are configured separately.\n# Changes are detected and reloaded automatically.\n\n${TOML.stringify({ version: 1, mcp_servers: mcpServers } as TOML.JsonMap)}`;
}
