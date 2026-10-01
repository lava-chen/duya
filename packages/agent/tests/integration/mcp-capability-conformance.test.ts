/**
 * MCP capability conformance — resources, prompts and notifications.
 *
 * Companion to `mcp-conformance.test.ts` (tools plane, L1–L9). This suite
 * covers the data plane and the non-tool notification surface, driving
 * the REAL `MCPClient` (chain A production class) against a real MCP SDK
 * server over `InMemoryTransport` via the documented `buildTransport`
 * seam — no subprocess, no HTTP.
 *
 * Every test here corresponds to a gap recorded in
 * docs/mcp/MCP_CAPABILITY_AUDIT.md:
 *
 *   R1  resources/list is fully paginated  (regression: page-one-only)
 *   R2  cursor ring is a protocol error, not an infinite loop
 *   R3  resources/read returns contents
 *   R4  capability gating — a server without `resources` never gets a
 *       pointless round-trip, and says so
 *   R5  resources/prompts list_changed are observed, not dropped
 *   C1  the tools plane is untouched by any of the above
 *   C2  initialize retains the full negotiated capability set
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCPClient } from '../../src/mcp/index.js';
import type { MCPServerConfig } from '../../src/types.js';

const RESOURCE_PAGE_SIZE = 2;

interface ProbeServer {
  clientTransport: Transport;
  setResources: (uris: string[]) => void;
  notifyResourcesChanged: () => void;
  notifyPromptsChanged: () => void;
  close: () => Promise<void>;
  readLog: string[];
}

interface FixtureOptions {
  tools?: string[];
  resources?: string[];
  /** Omit the `resources` capability from the initialize result. */
  withoutResourcesCapability?: boolean;
  /** Make resources/list always return the same cursor. */
  cursorRing?: boolean;
}

/** A server that declares the full MCP surface so the client can be observed. */
async function createFullSurfaceServer(opts: FixtureOptions): Promise<ProbeServer> {
  let tools = [...(opts.tools ?? [])];
  let resources = [...(opts.resources ?? [])];
  const readLog: string[] = [];

  const capabilities: Record<string, unknown> = {
    tools: { listChanged: true },
    prompts: { listChanged: true },
    logging: {},
  };
  if (!opts.withoutResourcesCapability) {
    capabilities.resources = { listChanged: true, subscribe: false };
  }

  const server = new Server({ name: 'capability-fixture', version: '0.0.1' }, { capabilities });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((name) => ({
      name,
      description: `probe tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `ok:${request.params.name}` }],
  }));

  // Paginated on purpose: 3 resources at PAGE_SIZE 2 forces 2 pages.
  // The SDK refuses to register a resources handler on a server that did
  // not declare the capability — which is itself the contract under test.
  if (!opts.withoutResourcesCapability) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      if (opts.cursorRing) {
        return { resources: [{ uri: 'file:///ring' }], nextCursor: 'same-cursor' };
      }
      const cursor: string | undefined = request.params?.cursor;
      const start = cursor ? Number(cursor) : 0;
      const page = resources.slice(start, start + RESOURCE_PAGE_SIZE);
      const next =
        start + RESOURCE_PAGE_SIZE < resources.length ? String(start + RESOURCE_PAGE_SIZE) : undefined;
      return {
        resources: page.map((uri) => ({
          uri,
          name: `res ${uri}`,
          description: `resource ${uri}`,
          mimeType: 'text/plain',
        })),
        ...(next !== undefined ? { nextCursor: next } : {}),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      readLog.push(request.params.uri);
      return {
        contents: [
          { uri: request.params.uri, mimeType: 'text/plain', text: `content of ${request.params.uri}` },
        ],
      };
    });
  }

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', description: 'say hi', arguments: [] }],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    description: 'greet',
    messages: [
      { role: 'user' as const, content: { type: 'text' as const, text: `hello ${request.params.name}` } },
    ],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    clientTransport,
    readLog,
    setResources: (uris) => {
      resources = [...uris];
    },
    notifyResourcesChanged: () => {
      void server.notification({ method: 'notifications/resources/list_changed' });
    },
    notifyPromptsChanged: () => {
      void server.notification({ method: 'notifications/prompts/list_changed' });
    },
    close: async () => {
      await server.close().catch(() => undefined);
    },
  };
}

class ProbeClient extends MCPClient {
  private injected: Transport | null = null;
  setInjectedTransport(t: Transport): void {
    this.injected = t;
  }
  protected override buildTransport(): Transport {
    if (!this.injected) throw new Error('fixture did not inject a transport');
    return this.injected;
  }
}

function makeConfig(name: string): MCPServerConfig {
  // `buildTransport` is overridden, so the stdio command is never used.
  return { name, transport: 'stdio', command: 'unused-by-fixture' };
}

const THREE_RESOURCES = ['file:///a.txt', 'file:///b.txt', 'file:///c.txt'];

describe('MCP capability conformance — data plane', () => {
  it('R1: resources/list is fully paginated (all pages, not page one)', async () => {
    const fx = await createFullSurfaceServer({ resources: THREE_RESOURCES });
    const client = new ProbeClient(makeConfig('res-pagination'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    // 3 resources at PAGE_SIZE 2 => 2 pages. The pre-fix client returned
    // only the first page (2 of 3) and reported no truncation.
    const listed = await client.listResources();
    expect(listed.map((r) => r.uri)).toEqual(THREE_RESOURCES);

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('R2: a server that repeats a cursor is a protocol error, not a hang', async () => {
    const fx = await createFullSurfaceServer({ resources: [], cursorRing: true });
    const client = new ProbeClient(makeConfig('res-cursor-ring'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    // listResources() degrades to [] on failure (never a partial list),
    // and the client stays connected and usable.
    const listed = await client.listResources();
    expect(listed).toEqual([]);
    expect(client.getStatus()).toBe('connected');

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('R3: resources/read returns the resource contents', async () => {
    const fx = await createFullSurfaceServer({ resources: THREE_RESOURCES });
    const client = new ProbeClient(makeConfig('res-read'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    const contents = await client.readResource('file:///a.txt');
    expect(contents).toHaveLength(1);
    expect(contents[0].text).toBe('content of file:///a.txt');
    expect(fx.readLog).toEqual(['file:///a.txt']);

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('R4: a server without the resources capability is reported, not probed', async () => {
    const fx = await createFullSurfaceServer({
      resources: THREE_RESOURCES,
      withoutResourcesCapability: true,
    });
    const client = new ProbeClient(makeConfig('res-no-capability'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    expect(client.supportsResources()).toBe(false);
    expect(client.supportsPrompts()).toBe(true);
    // No round-trip is spent, and the read half fails loudly instead of
    // returning an indistinguishable empty result.
    expect(await client.listResources()).toEqual([]);
    await expect(client.readResource('file:///a.txt')).rejects.toMatchObject({
      code: 'MCP_PROTOCOL',
    });

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('R5: resources/prompts list_changed are observed and never touch the tool inventory', async () => {
    const fx = await createFullSurfaceServer({ tools: ['alpha'], resources: ['file:///a.txt'] });
    const client = new ProbeClient(makeConfig('res-notify'));
    client.setInjectedTransport(fx.clientTransport);
    const toolChanges: string[] = [];
    client.setOnToolsChanged((n) => toolChanges.push(n));
    await client.connect();

    expect(client.supportsResources()).toBe(true);
    const before = client.getCapabilityChangeCount();

    fx.setResources(['file:///a.txt', 'file:///b.txt', 'file:///z.txt']);
    fx.notifyResourcesChanged();
    fx.notifyPromptsChanged();
    await new Promise((r) => setTimeout(r, 900));

    // Counted + logged instead of dropped by the SDK...
    expect(client.getCapabilityChangeCount()).toBe(before + 2);
    // ...and crucially NOT mistaken for a tool change.
    expect(toolChanges).toEqual([]);
    expect(client.getTools().map((t) => t.name)).toEqual(['alpha']);
    expect(client.getStatus()).toBe('connected');

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('C1: the tools plane is unchanged by the data-plane work', async () => {
    const fx = await createFullSurfaceServer({ tools: ['alpha', 'beta'], resources: [] });
    const client = new ProbeClient(makeConfig('tools-unchanged'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    expect(client.getTools().map((t) => t.name)).toEqual(['alpha', 'beta']);
    const called = await client.callTool('alpha', { query: 'x' });
    expect(called.error).toBeFalsy();
    expect(called.result).toBe('ok:alpha');

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('C2: initialize retains the full negotiated capability set', async () => {
    const fx = await createFullSurfaceServer({ tools: [], resources: [] });
    const client = new ProbeClient(makeConfig('caps'));
    client.setInjectedTransport(fx.clientTransport);
    await client.connect();

    // Duya captures the whole set — the audit's point is that it now acts
    // on `resources` instead of merely remembering it.
    const caps = client.getServerCapabilities();
    expect(caps).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    });
    expect(client.supportsResources()).toBe(true);
    expect(client.supportsPrompts()).toBe(true);

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });
});
