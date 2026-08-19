import { describe, expect, it } from 'vitest';
import { parseUserMcpToml, stringifyUserMcpToml } from '../../src/mcp/user-config';

describe('user MCP TOML', () => {
  it('round-trips stdio and streamable HTTP servers without conflating plugin data', () => {
    const text = stringifyUserMcpToml([
      {
        name: 'factory-tools',
        command: 'npx',
        args: ['-y', '@factory/mcp'],
        env: { FACTORY_TOKEN: '${FACTORY_TOKEN}' },
        enabled: true,
        allowedAgentIds: ['code'],
      },
      {
        name: 'factory-api',
        transport: 'streamable-http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer ${FACTORY_TOKEN}' },
        enabled: false,
      },
    ]);

    expect(text).toContain('mcp_servers');
    expect(parseUserMcpToml(text)).toEqual([
      {
        name: 'factory-tools',
        command: 'npx',
        args: ['-y', '@factory/mcp'],
        env: { FACTORY_TOKEN: '${FACTORY_TOKEN}' },
        enabled: true,
        allowedAgentIds: ['code'],
      },
      {
        name: 'factory-api',
        transport: 'streamable-http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer ${FACTORY_TOKEN}' },
        enabled: false,
      },
    ]);
  });

  it('rejects a malformed user-server shape before it reaches the runtime', () => {
    expect(() => parseUserMcpToml('[mcp_servers.bad]\nenabled = "yes"\n')).toThrow(
      'enabled must be a boolean',
    );
  });

  it('tolerates camelCase extended fields written by the main-process ConfigStore', () => {
    // The main process serializes its camelCase McpServerEntry verbatim into
    // config.toml (allowedAgentIds, nameOverride, ...). The worker must not
    // silently drop scope/timeout settings just because the key is camelCase.
    const parsed = parseUserMcpToml(`
[mcp_servers.foo]
command = "node"
args = ["-y", "@foo/mcp"]
enabled = true
allowedAgentIds = ["code", "researcher"]
nameOverride = "foo"
startupTimeoutSec = 15
toolTimeoutSec = 60
toolTimeouts = { "list" = 120 }
`);
    expect(parsed).toEqual([
      {
        name: 'foo',
        command: 'node',
        args: ['-y', '@foo/mcp'],
        enabled: true,
        allowedAgentIds: ['code', 'researcher'],
        nameOverride: 'foo',
        startupTimeoutSec: 15,
        toolTimeoutSec: 60,
        toolTimeouts: { list: 120 },
      },
    ]);
  });

  it('prefers snake_case extended fields when both spellings are present', () => {
    const parsed = parseUserMcpToml(`
[mcp_servers.foo]
command = "node"
enabled = true
allowedAgentIds = ["camel"]
allowed_agent_ids = ["snake"]
`);
    expect(parsed[0]?.allowedAgentIds).toEqual(['snake']);
  });
});
