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
});
