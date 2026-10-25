/**
 * `GET /v1/mcps` over HTTP.
 *
 * ## What is under test
 *
 * The ROUTE and the CLIENT METHOD, against a real HTTP server.
 *
 * Two things can go wrong at this boundary and they are not the same
 * failure:
 *
 * 1. A Host that was given no inventory capability must REFUSE (404 with a
 *    named code). An empty list would be a lie — it would say "the user
 *    configured no MCP servers" about a Host that simply cannot tell.
 * 2. A Host that CAN answer must answer with the servers, sorted, and
 *    without a credential in sight.
 *
 * The capability under test is a FAKE: it answers whatever the test scripts.
 * The projection itself is covered by `mcp-inventory-api.test.ts`.
 *
 * The last block drives a REAL local Host, because "the route is wired in
 * `local-host.ts`" is a claim about the composition and only the composition
 * can confirm it.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostSessionApiV1 } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const TOKEN = 'mcp-inventory-test-token';

let server: HostSessionHttpServer | null = null;
const hosts: LocalHostHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A session API whose `get` answers for exactly the listed sessions. */
function sessionApi(known: readonly string[]): HostSessionApiV1 {
  return {
    async get(sessionId: string) {
      return known.includes(sessionId) ? ({ id: sessionId } as never) : null;
    },
  } as unknown as HostSessionApiV1;
}

async function startServer(
  options: Partial<HostSessionHttpServerOptions> & { api?: HostSessionApiV1 },
): Promise<{ origin: string; client: HostSessionHttpClient }> {
  server = new HostSessionHttpServer({
    api: options.api ?? sessionApi(['session-1']),
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...options,
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

describe('GET /v1/mcps', () => {
  it('answers 404 mcp_inventory_api_unavailable when the capability is not wired', async () => {
    const { origin } = await startServer({});

    const response = await fetch(`${origin}/v1/mcps`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'mcp_inventory_api_unavailable' },
    });
  });

  it('answers 200 with the server list when the capability is wired', async () => {
    const { origin } = await startServer({
      mcpInventoryApi: {
        async listServers() {
          return {
            servers: [
              { name: 'alpha', transport: 'stdio' as const, command: 'node', enabled: true },
              { name: 'beta', transport: 'streamable-http' as const, url: 'https://example.invalid/mcp', enabled: false },
            ],
          };
        },
      },
    });

    const response = await fetch(`${origin}/v1/mcps`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      servers: [
        { name: 'alpha', transport: 'stdio', command: 'node', enabled: true },
        { name: 'beta', transport: 'streamable-http', url: 'https://example.invalid/mcp', enabled: false },
      ],
    });
  });

  it('is not swallowed by another matcher', async () => {
    // The path is top-level, next to `/v1/sessions` and `/v1/projects`. A
    // matcher registered earlier that claimed `/v1/<anything>` would answer
    // "unknown route" here instead of reaching the inventory.
    const { origin } = await startServer({
      mcpInventoryApi: { async listServers() { return { servers: [] }; } },
    });

    const response = await fetch(`${origin}/v1/mcps`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
  });

  it('answers 405 for a method that is not a read', async () => {
    const { origin } = await startServer({
      mcpInventoryApi: { async listServers() { return { servers: [] }; } },
    });

    const response = await fetch(`${origin}/v1/mcps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(405);
  });
});

describe('the Host client method', () => {
  it('reads the server list out of the answer', async () => {
    const { client } = await startServer({
      mcpInventoryApi: {
        async listServers() {
          return {
            servers: [
              { name: 'alpha', transport: 'stdio' as const, command: 'node', enabled: true },
            ],
          };
        },
      },
    });

    await expect(client.listMcpServers()).resolves.toEqual({
      servers: [{ name: 'alpha', transport: 'stdio', command: 'node', enabled: true }],
    });
  });

  it('turns the refusal into a typed client error', async () => {
    const { client } = await startServer({});

    await expect(client.listMcpServers()).rejects.toMatchObject({
      status: 404,
      code: 'mcp_inventory_api_unavailable',
    });
  });
});

describe('the inventory in a running local Host', () => {
  it('answers with the servers the Host data root configures', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-mcp-inventory-'));
    roots.push(dataRoot);
    await fs.writeFile(
      path.join(dataRoot, 'config.toml'),
      [
        '[mcp_servers.filesystem]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
        'enabled = true',
        '',
        '[mcp_servers.notes]',
        'transport = "streamable-http"',
        'url = "https://example.invalid/mcp"',
        'enabled = false',
        '',
      ].join('\n'),
      'utf8',
    );

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    const result = await client.listMcpServers();

    expect(result.servers.map((server) => server.name)).toEqual(['filesystem', 'notes']);
    expect(result.servers.find((server) => server.name === 'notes')).toMatchObject({
      transport: 'streamable-http',
      url: 'https://example.invalid/mcp',
      enabled: false,
    });
    // The command line is configuration, not a credential, so it travels.
    expect(result.servers[0]!.command).toBe('npx');
  });

  it('answers an empty list for a data root with no MCP section', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-mcp-inventory-empty-'));
    roots.push(dataRoot);

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    await expect(client.listMcpServers()).resolves.toEqual({ servers: [] });
  });
});
