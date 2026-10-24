/**
 * The MCP inventory as a capability.
 *
 * What is under test is the PROJECTION: what the Host is willing to say
 * about a server the user configured.
 *
 * The property that matters most here is NEGATIVE — a credential must not be
 * in the answer — because the answer travels to every client that can reach
 * the Host, and the configuration it is projected from carries `env` and
 * `headers`. A single leaked token is enough to make the whole route
 * unusable, so the assertion is on the serialized answer, not only on the
 * fields the contract happens to name.
 *
 * The second property is ORDER. The list is sorted by code unit rather than
 * by locale, so "the servers, in order" is the same list on every machine —
 * a locale-aware sort would reorder the same configuration depending on who
 * asked.
 */

import { describe, expect, it } from 'vitest';
import type { UserMcpTomlServer } from '@duya/plugin-core/mcp/user-config';
import { createHostMcpInventoryApi } from '../src/mcp-inventory-api.js';

/** An inventory over a fixed configuration, with no file behind it. */
function inventoryFor(servers: readonly UserMcpTomlServer[]) {
  return createHostMcpInventoryApi({
    async listServers() {
      return servers;
    },
  });
}

describe('the MCP inventory', () => {
  it('lists the servers the configuration carries', async () => {
    const api = inventoryFor([
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        enabled: true,
      },
      {
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
        enabled: true,
        nameOverride: 'rem',
        startupTimeoutSec: 30,
        toolTimeoutSec: 15,
      },
    ]);

    await expect(api.listServers()).resolves.toEqual({
      servers: [
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          enabled: true,
        },
        {
          name: 'remote',
          transport: 'streamable-http',
          url: 'https://example.invalid/mcp',
          enabled: true,
          nameOverride: 'rem',
          startupTimeoutSec: 30,
          toolTimeoutSec: 15,
        },
      ],
    });
  });

  it('answers a configuration with no MCP section as an empty list', async () => {
    await expect(inventoryFor([]).listServers()).resolves.toEqual({ servers: [] });
  });

  it('never carries the credentials the configuration holds', async () => {
    const api = inventoryFor([
      {
        name: 'secretive',
        command: 'node',
        enabled: true,
        env: { API_TOKEN: 'super-secret-value' },
        headers: { Authorization: 'Bearer header-secret-value' },
      },
    ]);

    const result = await api.listServers();

    expect(result.servers[0]).not.toHaveProperty('env');
    expect(result.servers[0]).not.toHaveProperty('headers');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('header-secret-value');
  });

  it('orders the servers by code unit, not by locale', async () => {
    const api = inventoryFor([
      { name: 'alpha', enabled: true },
      { name: 'Zeta', enabled: true },
      { name: 'Beta', enabled: true },
    ]);

    const names = (await api.listServers()).servers.map((server) => server.name);

    // Code units: 'B' (66) < 'Z' (90) < 'a' (97). A locale-aware sort would
    // put 'alpha' first, so this assertion fails if `localeCompare` creeps in.
    expect(names).toEqual(['Beta', 'Zeta', 'alpha']);
    expect(names).not.toEqual(['alpha', 'Beta', 'Zeta']);
  });

  it('lists a disabled server, and says that it is disabled', async () => {
    const api = inventoryFor([
      { name: 'off', command: 'node', enabled: false },
      { name: 'on', command: 'node', enabled: true },
    ]);

    const result = await api.listServers();

    // The user configured it; that is a fact about the configuration, and a
    // client that renders "2 servers" and one that renders "1 server" are
    // answering different questions.
    expect(result.servers).toHaveLength(2);
    expect(result.servers.find((server) => server.name === 'off')).toEqual({
      name: 'off',
      command: 'node',
      enabled: false,
    });
  });

  it('does not hand out the configuration it was given', async () => {
    const configured: UserMcpTomlServer[] = [
      { name: 'one', command: 'node', args: ['--flag'], enabled: true },
    ];
    const api = inventoryFor(configured);

    const result = await api.listServers();

    // The answer is a copy: a caller that mutates the array it received
    // must not be able to reach into the configuration the Host read.
    expect(result.servers[0]!.args).toEqual(['--flag']);
    expect(result.servers[0]!.args).not.toBe(configured[0]!.args);
  });
});
