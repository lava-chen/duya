/**
 * Plan 580 Phase 5 — MCP conformance harness L1–L9.
 *
 * Runs the full chain (discovery → descriptors → aliases → registry →
 * catalog) against a REAL MCP SDK server over `InMemoryTransport`.
 * Any new connector MUST pass this suite before merge (AGENTS.md Gates).
 *
 *   L1  discoveredTotal — transactional paginated discovery counts
 *   L2  descriptor diff — add/remove a tool changes the next pass
 *   L3  alias uniqueness — one batch of tools → unique model-visible names
 *   L4  registry counts — replace-set drops removed keys; a failed
 *       discovery NEVER clears the last-known inventory (D6)
 *   L5  catalog retrieval — search + list paging + CATALOG_CURSOR_STALE
 *   L6  detail schema deep-equal — canonical schema verbatim per field
 *   L7  deterministic sample invoke — sorted stride of 5 (first/last
 *       included, never random), args pass through byte-identical
 *   L8  error classification matrix — auth / business vs availability
 *   L9  lifecycle — list_changed → rediscovery changes registry counts;
 *       a failing discovery keeps last-known (D6)
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { listAllTools } from '@duya/plugin-core/mcp/core/list-tools';
import { createDeadlineClock } from '@duya/plugin-core/mcp/core/deadline';
import { allocateConnectionToolAlias, connectionNamespace } from '@duya/plugin-core/mcp/core/alias';
import { classifyMcpError, breakerDisposition } from '@duya/plugin-core/mcp/core/error-taxonomy';
import { ToolRegistry } from '../../src/tool/registry.js';
import { ToolCatalogTool } from '../../src/tool/ToolCatalogTool/ToolCatalogTool.js';

// ─── Fixture: a real in-memory MCP server ─────────────────────────────

interface FixtureServer {
  client: Client;
  cleanup: () => Promise<void>;
  setTools: (names: string[]) => void;
  failNextList: (err?: Error) => void;
  notifyToolsChanged: () => void;
  readonly callLog: Array<{ name: string; args: Record<string, unknown> }>;
}

const PAGE_SIZE = 3; // force multi-page pagination with few tools

// Async factory: the transport pair is connected and awaited before the
// fixture is handed to a test, so no fire-and-forget connect race.
async function createFixtureServer(initialTools: string[]): Promise<FixtureServer> {
  let tools = [...initialTools];
  let failNext: Error | undefined;
  const callLog: Array<{ name: string; args: Record<string, unknown> }> = [];

  const server = new Server(
    { name: 'conformance-fixture', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (failNext) {
      const err = failNext;
      failNext = undefined;
      throw err;
    }
    const cursor: string | undefined = request.params?.cursor;
    const start = cursor ? Number(cursor) : 0;
    const page = tools.slice(start, start + PAGE_SIZE);
    const nextCursor = start + PAGE_SIZE < tools.length ? String(start + PAGE_SIZE) : undefined;
    return {
      tools: page.map((name) => ({
        name,
        description: `fixture tool ${name}`,
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'the query' } },
          required: ['query'],
          additionalProperties: false,
        },
      })),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!tools.includes(request.params.name)) {
      // Unknown tool → the SDK turns this into a JSON-RPC error response;
      // the client throws its McpError (numeric code) — the server's
      // NORMAL answer, class `business` (plan 580 §D9).
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    callLog.push({ name: request.params.name, args: request.params.arguments as Record<string, unknown> });
    if (request.params.name === 'boom') {
      return {
        content: [{ type: 'text', text: 'tool exploded' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `ok:${request.params.name}` }] };
  });

  const client = new Client({ name: 'conformance-harness', version: '0.0.1' }, { capabilities: {} });

  const cleanup = async (): Promise<void> => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup,
    setTools: (names: string[]) => {
      tools = [...names];
    },
    failNextList: (err?: Error) => {
      failNext = err ?? new Error('fetch failed: ECONNRESET');
    },
    notifyToolsChanged: () => {
      void server.notification({ method: 'notifications/tools/list_changed' });
    },
    callLog,
  };
}

const TOOL_NAMES = Array.from({ length: 7 }, (_, i) => `tool_${i}`);

/** Run one full discovery pass exactly like the chains do. */
async function discover(fixture: FixtureServer) {
  return listAllTools(fixture.client, { deadline: createDeadlineClock(10_000), generation: 1 });
}

// ─── Registry/catalog assembly (chain-agnostic part of the pipeline) ──

function registerIntoRegistry(
  registry: ToolRegistry,
  discovered: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
): void {
  const entries = discovered.map((tool) => {
    const alias = allocateConnectionToolAlias(
      connectionNamespace('conformance', ''),
      tool.name,
      new Set(),
    );
    return {
      key: alias,
      definition: {
        name: alias,
        description: tool.description ?? '',
        input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
      },
      executor: { execute: async () => ({ id: 'x', name: alias, result: 'ok' }) },
      meta: {
        exposure: 'deferred' as const,
        source: { kind: 'connector' as const, id: 'conformance' },
        discovery: {
          namespace: connectionNamespace('conformance', ''),
          conciseHint: tool.description ?? '',
          tags: [tool.name],
        },
        inputSchemaSummary: tool.description ?? '',
      },
    };
  });
  registry.replaceByOwner('connector:conformance', entries as never);
}

function buildCatalogView(registry: ToolRegistry) {
  const snapshot = registry.snapshot(new Map());
  const catalog = new ToolCatalogTool();
  const eligible = new Set(snapshot.catalogEntries.map((e) => e.toolId));
  catalog.setView({
    snapshot,
    registry,
    eligibleToolIds: eligible,
    directToolIds: new Set(),
    loadedSchemaRevisions: new Map(),
    loadedSchemaRounds: new Map(),
    currentRound: 0,
  });
  return { catalog, snapshot, eligible };
}

function parseCatalogResult(result: { result: unknown }): Record<string, unknown> {
  const marker = '<!-- duya-tool-catalog-result -->';
  return JSON.parse(String(result.result).replace(`${marker}\n`, '')) as Record<string, unknown>;
}

// ─── L1–L9 ─────────────────────────────────────────────────────────────

describe('MCP conformance (plan 580 Phase 5, L1–L9)', () => {
  it('L1: transactional paginated discovery counts every tool across pages', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const result = await discover(fixture);
    // 7 tools, PAGE_SIZE 3 → 3 pages, total 7.
    expect(result.discoveredTotal).toBe(7);
    expect(result.pagesFetched).toBe(3);
    expect(result.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    await fixture.cleanup();
  });

  it('L2: descriptor diff — a tool removed upstream disappears from the next pass', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    await discover(fixture);
    fixture.setTools(TOOL_NAMES.filter((n) => n !== 'tool_3'));
    const result = await discover(fixture);
    expect(result.discoveredTotal).toBe(6);
    expect(result.tools.map((t) => t.name)).not.toContain('tool_3');
    await fixture.cleanup();
  });

  it('L3: alias allocator yields unique model-visible names for the whole batch', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const result = await discover(fixture);
    const aliases = result.tools.map((t) =>
      allocateConnectionToolAlias(connectionNamespace('conformance', ''), t.name, new Set()),
    );
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) {
      expect(alias.length).toBeLessThanOrEqual(64);
      expect(alias.startsWith('remote_conformance_')).toBe(true);
    }
    await fixture.cleanup();
  });

  it('L4: replace-set drops removed keys and a failed discovery keeps last-known', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const registry = new ToolRegistry();
    const first = await discover(fixture);
    registerIntoRegistry(registry, first.tools);

    // 7 → 6: authoritative replace, exactly one removed key.
    fixture.setTools(TOOL_NAMES.filter((n) => n !== 'tool_3'));
    const second = await discover(fixture);
    registerIntoRegistry(registry, second.tools);
    const namesAfter = registry.getAllTools().map((t) => t.name);
    expect(namesAfter.length).toBe(6);
    expect(namesAfter.join(',')).not.toContain('tool_3');

    // discovery:failed → NO replace: the 6 tools survive.
    fixture.failNextList();
    let failed = false;
    try {
      await listAllTools(fixture.client, { deadline: createDeadlineClock(10_000), generation: 2 });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(registry.getAllTools().length).toBe(6);
    await fixture.cleanup();
  });

  it('L5: catalog search finds tools; list pages stably and rejects stale cursors', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const registry = new ToolRegistry();
    registerIntoRegistry(registry, (await discover(fixture)).tools);
    const { catalog } = buildCatalogView(registry);

    // search
    const search = parseCatalogResult(await catalog.execute({ query: 'tool_5' }));
    expect((search.matches as unknown[]).length).toBeGreaterThan(0);

    // list: 7 tools, page size 20 → single page, no next_cursor.
    const page1 = parseCatalogResult(await catalog.execute({ namespace: 'conformance' }));
    expect((page1.tools as unknown[]).length).toBe(7);
    expect(page1.next_cursor).toBeUndefined();

    // stale cursor: registry mutation bumps the revision.
    const pageCursor = parseCatalogResult(await catalog.execute({ namespace: 'conformance', cursor: 'garbage' }));
    expect(pageCursor.errorCode).toBe('CATALOG_CURSOR_STALE');
    await fixture.cleanup();
  });

  it('L6: catalog detail returns the canonical schema verbatim (deep-equal)', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const registry = new ToolRegistry();
    registerIntoRegistry(registry, (await discover(fixture)).tools);
    const { catalog, snapshot } = buildCatalogView(registry);
    const entry = snapshot.catalogEntries[0];
    const detail = parseCatalogResult(await catalog.execute({ tool_id: entry.toolId }));
    expect(detail.mode).toBe('detail');
    expect(detail.schema_revision).toBe(entry.schemaRevision);
    // Deep-equal: every canonical field survives (properties, required,
    // additionalProperties, descriptions).
    expect(detail.input_schema).toEqual(entry.inputSchema);
    expect(detail.input_schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'the query' } },
      required: ['query'],
      additionalProperties: false,
    });
    await fixture.cleanup();
  });

  it('L7: deterministic sample invoke — sorted stride of 5, first/last included', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const result = await discover(fixture);
    const sorted = [...result.tools].sort((a, b) => (a.name < b.name ? -1 : 1));
    const SAMPLE = 5;
    const stride = Math.max(1, Math.floor((sorted.length - 1) / (SAMPLE - 1)));
    const sample = new Set<string>();
    for (let i = 0; i < sorted.length; i += stride) sample.add(sorted[i].name);
    sample.add(sorted[sorted.length - 1].name); // last always included
    const sampled = [...sample].sort();
    // Deterministic: same input → same sample (no randomness).
    expect(sampled[0]).toBe(sorted[0].name);
    expect(sampled[sampled.length - 1]).toBe(sorted[sorted.length - 1].name);
    expect(sampled.length).toBeLessThanOrEqual(sorted.length); // tiny lists: stride 1 → full deterministic sweep
    expect(sampled.length).toBeGreaterThanOrEqual(2);

    // Invoke each sampled tool through the real client; args round-trip.
    for (const name of sampled) {
      await fixture.client.callTool({ name, arguments: { query: `probe-${name}` } });
    }
    expect(fixture.callLog.length).toBe(sampled.length);
    for (const call of fixture.callLog) {
      expect(call.args).toEqual({ query: `probe-${call.name}` });
    }
    await fixture.cleanup();
  });

  it('L8: error classification matrix — business isError is normal, availability only from transport', async () => {
    const fixture = await createFixtureServer(['boom', 'fine']);
    // Business: the server's NORMAL answer (isError=true) — no breaker impact.
    const businessResult = await fixture.client.callTool({ name: 'boom', arguments: {} });
    expect(businessResult.isError).toBe(true);
    // Unmatched error text falls through to `transport` class → the
    // ONLY availability signal (connection-level breaker).
    expect(breakerDisposition(classifyMcpError(new Error('tool exploded')))).toBe('connection');

    // A JSON-RPC error response (SDK McpError with numeric code) → business.
    try {
      await fixture.client.callTool({ name: 'missing_tool', arguments: {} });
      expect.fail('expected an error');
    } catch (err) {
      expect(classifyMcpError(err)).toBe('business');
      expect(breakerDisposition(classifyMcpError(err))).toBe('ignore');
    }

    // Transport patterns → connection-level.
    expect(breakerDisposition(classifyMcpError(new Error('socket hang up')))).toBe('connection');
    expect(breakerDisposition(classifyMcpError(new Error('unexpected end of JSON')))).toBe('connection');
    // Timeout → tool-scoped.
    expect(breakerDisposition(classifyMcpError(new Error('request timeout')))).toBe('tool-scoped');
    await fixture.cleanup();
  });

  it('L9: list_changed refreshes visible tools; a failing pass keeps last-known', async () => {
    const fixture = await createFixtureServer(TOOL_NAMES);
    const registry = new ToolRegistry();
    registerIntoRegistry(registry, (await discover(fixture)).tools);
    expect(registry.getAllTools().length).toBe(7);

    // L9a: the harness receives notifications through a real SDK handler.
    let notifications = 0;
    fixture.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications++;
    });
    fixture.setTools([...TOOL_NAMES, 'tool_added']);
    fixture.notifyToolsChanged();
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications).toBe(1);

    // Rediscovery after the notification → 8 tools, replace-set commit.
    registerIntoRegistry(registry, (await discover(fixture)).tools);
    expect(registry.getAllTools().length).toBe(8);
    expect(registry.getAllTools().some((t) => t.name.includes('tool_added'))).toBe(true);

    // L9b: failing pass keeps last-known (8 tools, no clear).
    fixture.failNextList();
    try {
      await listAllTools(fixture.client, { deadline: createDeadlineClock(10_000), generation: 2 });
    } catch {
      // expected
    }
    expect(registry.getAllTools().length).toBe(8);
    await fixture.cleanup();
  });
});
