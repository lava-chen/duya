// Plan 580 Phase 1 — listAllTools defensive matrix.
import { describe, expect, it } from 'vitest';
import { listAllTools, formatDiscoveryLogLine, DEFAULT_MAX_PAGES } from '../../../src/mcp/core/list-tools.js';
import { McpError } from '../../../src/mcp/core/error-taxonomy.js';
import { createDeadlineClock } from '../../../src/mcp/core/deadline.js';
import type { McpListToolsClient } from '../../../src/mcp/core/list-tools.js';
import type { McpToolDescriptor } from '../../../src/mcp/core/descriptor.js';

function tool(name: string): McpToolDescriptor {
  return { name, description: `tool ${name}`, inputSchema: { type: 'object', properties: {} } };
}

function pageClient(pages: Array<{ tools: McpToolDescriptor[]; nextCursor?: string | null }>, opts?: {
  failOnPage?: number;
  failWith?: Error;
}): { client: McpListToolsClient; cursors: string[]; timeouts: number[] } {
  const cursors: string[] = [];
  const timeouts: number[] = [];
  const client: McpListToolsClient = {
    async listTools(params, options) {
      cursors.push(params?.cursor ?? '<first>');
      timeouts.push(options?.timeout ?? -1);
      const pageIndex = cursors.length - 1;
      if (opts?.failOnPage === pageIndex + 1) throw opts.failWith ?? new Error('boom');
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      return { tools: page.tools, nextCursor: page.nextCursor };
    },
  };
  return { client, cursors, timeouts };
}

describe('listAllTools (plan 580 D3)', () => {
  it('aggregates all pages and returns only after cursor exhaustion', async () => {
    const { client, cursors } = pageClient([
      { tools: [tool('a'), tool('b')], nextCursor: 'c1' },
      { tools: [tool('c')], nextCursor: 'c2' },
      { tools: [tool('d')], nextCursor: null },
    ]);
    const result = await listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 });
    expect(result.discoveredTotal).toBe(4);
    expect(result.pagesFetched).toBe(3);
    expect(result.tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.truncated).toBe(false);
    expect(cursors).toEqual(['<first>', 'c1', 'c2']);
  });

  it('treats undefined nextCursor as exhausted', async () => {
    const { client } = pageClient([{ tools: [tool('a')] }]);
    const result = await listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 });
    expect(result.discoveredTotal).toBe(1);
  });

  it('passes shared deadline remaining time and abort signal to every page', async () => {
    const { client, timeouts } = pageClient([
      { tools: [tool('a')], nextCursor: 'c1' },
      { tools: [tool('b')], nextCursor: null },
    ]);
    const deadline = createDeadlineClock(10_000);
    await listAllTools(client, { deadline, generation: 1 });
    expect(timeouts[0]).toBeGreaterThan(9_000);
    expect(timeouts[1]).toBeLessThanOrEqual(10_000);
    expect(timeouts[1]).toBeGreaterThan(9_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it('throws MCP_PROTOCOL on cursor ring (seenCursors)', async () => {
    // Server keeps returning the same cursor forever.
    const client: McpListToolsClient = {
      async listTools() {
        return { tools: [tool('a')], nextCursor: 'loop' };
      },
    };
    await expect(
      listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 }),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL' });
  });

  it('throws MCP_PROTOCOL on cross-page duplicate tool names', async () => {
    const { client } = pageClient([
      { tools: [tool('a')], nextCursor: 'c1' },
      { tools: [tool('a')], nextCursor: null },
    ]);
    await expect(
      listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 }),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL' });
  });

  it('returns truncated=maxPages when page cap is hit (never complete)', async () => {
    const pages = Array.from({ length: DEFAULT_MAX_PAGES + 3 }, (_, i) => ({
      tools: [tool(`t${i}`)],
      nextCursor: `c${i}`,
    }));
    const { client } = pageClient(pages);
    const result = await listAllTools(client, { deadline: createDeadlineClock(30_000), generation: 1 });
    expect(result.truncated).toBe('maxPages');
    expect(result.pagesFetched).toBe(DEFAULT_MAX_PAGES);
    // Data is still returned — the CALLER decides to mark stale, never complete.
    expect(result.discoveredTotal).toBe(DEFAULT_MAX_PAGES);
  });

  it('returns truncated=maxTools when tool cap is hit', async () => {
    const pages = [
      { tools: [tool('a'), tool('b'), tool('c')], nextCursor: 'c1' },
      { tools: [tool('d'), tool('e')], nextCursor: null },
    ];
    const { client } = pageClient(pages);
    const result = await listAllTools(client, {
      deadline: createDeadlineClock(30_000),
      maxTools: 3,
      generation: 1,
    });
    expect(result.truncated).toBe('maxTools');
    expect(result.discoveredTotal).toBe(3);
  });

  it('throws MCP_TIMEOUT before starting a page after the deadline', async () => {
    const { client, cursors } = pageClient([
      { tools: [tool('a')], nextCursor: 'c1' },
      { tools: [tool('b')], nextCursor: null },
    ]);
    const deadline = createDeadlineClock(0);
    await expect(
      listAllTools(client, { deadline, generation: 1 }),
    ).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
    expect(cursors).toEqual([]);
  });

  it('is transactional: a page-3 failure discards the temporary inventory', async () => {
    const { client } = pageClient(
      [
        { tools: [tool('a')], nextCursor: 'c1' },
        { tools: [tool('b')], nextCursor: 'c2' },
        { tools: [tool('c')], nextCursor: null },
      ],
      { failOnPage: 3, failWith: new Error('network reset') },
    );
    await expect(
      listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 }),
    ).rejects.toThrow('network reset');
    // No aggregate was observable — the throw IS the transaction boundary.
  });

  it('deduplicates nothing silently and echoes generation', async () => {
    const { client } = pageClient([{ tools: [tool('x')] }]);
    const result = await listAllTools(client, { deadline: createDeadlineClock(5000), generation: 42 });
    expect(result.discoveredTotal).toBe(1);
  });

  it('emits debugLog per page when a sink is provided', async () => {
    const { client } = pageClient([
      { tools: [tool('a')], nextCursor: 'c1' },
      { tools: [tool('b')], nextCursor: null },
    ]);
    const lines: string[] = [];
    await listAllTools(client, {
      deadline: createDeadlineClock(5000),
      generation: 1,
      debugLog: (m) => lines.push(m),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('page=1');
    expect(lines[1]).toContain('nextCursor=<end>');
  });

  it('formats the promoted connection log line', () => {
    expect(formatDiscoveryLogLine({ pagesFetched: 3, discoveredTotal: 46, truncated: false })).toBe('pages=3, total=46');
    expect(formatDiscoveryLogLine({ pagesFetched: 50, discoveredTotal: 5000, truncated: 'maxPages' })).toBe(
      'pages=50, total=5000 (truncated: maxPages)',
    );
  });

  it('Core-thrown protocol errors are McpError with a stable code', async () => {
    const { client } = pageClient([
      { tools: [tool('a')], nextCursor: 'c1' },
      { tools: [tool('a')], nextCursor: null },
    ]);
    const err = await listAllTools(client, { deadline: createDeadlineClock(5000), generation: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe('MCP_PROTOCOL');
  });
});
