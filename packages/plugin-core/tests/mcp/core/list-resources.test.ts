// plan 580 follow-up — paginated resources/list + resources/read.
// Mirrors the list-tools defensive matrix so the two cursors are held to
// the SAME contract (see core/paginate.ts).
import { describe, expect, it } from 'vitest';
import {
  listAllResources,
  readResource,
  serverSupportsResources,
  serverSupportsPrompts,
  DEFAULT_MAX_RESOURCE_PAGES,
} from '../../../src/mcp/core/list-resources.js';
import { McpError } from '../../../src/mcp/core/error-taxonomy.js';
import { createDeadlineClock } from '../../../src/mcp/core/deadline.js';
import type {
  McpListResourcesClient,
  McpResourceDescriptor,
} from '../../../src/mcp/core/list-resources.js';

function resource(uri: string): McpResourceDescriptor {
  return { uri, name: `res ${uri}`, mimeType: 'text/plain' };
}

function pageClient(
  pages: Array<{ resources: McpResourceDescriptor[]; nextCursor?: string | null }>,
  opts?: { failOnPage?: number; failWith?: Error },
): { client: McpListResourcesClient; cursors: string[]; timeouts: number[]; reads: string[] } {
  const cursors: string[] = [];
  const timeouts: number[] = [];
  const reads: string[] = [];
  const client: McpListResourcesClient = {
    async listResources(params, options) {
      cursors.push(params?.cursor ?? '<first>');
      timeouts.push(options?.timeout ?? -1);
      const pageIndex = cursors.length - 1;
      if (opts?.failOnPage === pageIndex + 1) throw opts.failWith ?? new Error('boom');
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      return { resources: page.resources, nextCursor: page.nextCursor };
    },
    async readResource(params, options) {
      reads.push(params.uri);
      expect(options?.timeout ?? -1).toBeGreaterThan(0);
      return { contents: [{ uri: params.uri, text: `content of ${params.uri}` }] };
    },
  };
  return { client, cursors, timeouts, reads };
}

describe('listAllResources (paginated data plane)', () => {
  it('aggregates every page and returns only after cursor exhaustion', async () => {
    const { client, cursors } = pageClient([
      { resources: [resource('a'), resource('b')], nextCursor: 'c1' },
      { resources: [resource('c')], nextCursor: 'c2' },
      { resources: [resource('d')], nextCursor: null },
    ]);
    const result = await listAllResources(client, { deadline: createDeadlineClock(5000) });
    expect(result.discoveredTotal).toBe(4);
    expect(result.pagesFetched).toBe(3);
    expect(result.resources.map((r) => r.uri)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.truncated).toBe(false);
    expect(cursors).toEqual(['<first>', 'c1', 'c2']);
  });

  it('treats undefined nextCursor as exhausted', async () => {
    const { client } = pageClient([{ resources: [resource('a')] }]);
    const result = await listAllResources(client, { deadline: createDeadlineClock(5000) });
    expect(result.discoveredTotal).toBe(1);
    expect(result.pagesFetched).toBe(1);
  });

  it('passes the shared deadline remaining time and abort signal to every page', async () => {
    const { client, timeouts } = pageClient([
      { resources: [resource('a')], nextCursor: 'c1' },
      { resources: [resource('b')], nextCursor: null },
    ]);
    const deadline = createDeadlineClock(10_000);
    await listAllResources(client, { deadline });
    expect(timeouts[0]).toBeGreaterThan(9_000);
    expect(timeouts[1]).toBeGreaterThan(9_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it('throws MCP_PROTOCOL on cursor ring instead of looping forever', async () => {
    const client: McpListResourcesClient = {
      async listResources() {
        return { resources: [resource('a')], nextCursor: 'loop' };
      },
      async readResource() {
        return { contents: [] };
      },
    };
    await expect(
      listAllResources(client, { deadline: createDeadlineClock(5000) }),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL' });
  });

  it('throws MCP_PROTOCOL on cross-page duplicate URIs', async () => {
    const { client } = pageClient([
      { resources: [resource('a')], nextCursor: 'c1' },
      { resources: [resource('a')], nextCursor: null },
    ]);
    await expect(
      listAllResources(client, { deadline: createDeadlineClock(5000) }),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL' });
  });

  it('returns truncated=maxPages when the page cap is hit', async () => {
    const pages = Array.from({ length: DEFAULT_MAX_RESOURCE_PAGES + 3 }, (_, i) => ({
      resources: [resource(`r${i}`)],
      nextCursor: `c${i}`,
    }));
    const { client } = pageClient(pages);
    const result = await listAllResources(client, { deadline: createDeadlineClock(30_000) });
    expect(result.truncated).toBe('maxPages');
    expect(result.pagesFetched).toBe(DEFAULT_MAX_RESOURCE_PAGES);
  });

  it('returns truncated=maxTools when the resource cap is hit', async () => {
    const { client } = pageClient([
      { resources: [resource('a'), resource('b'), resource('c')], nextCursor: 'c1' },
      { resources: [resource('d')], nextCursor: null },
    ]);
    const result = await listAllResources(client, {
      deadline: createDeadlineClock(30_000),
      maxResources: 3,
    });
    expect(result.truncated).toBe('maxTools');
    expect(result.discoveredTotal).toBe(3);
  });

  it('throws MCP_TIMEOUT before starting a page after the deadline', async () => {
    const { client, cursors } = pageClient([
      { resources: [resource('a')], nextCursor: 'c1' },
      { resources: [resource('b')], nextCursor: null },
    ]);
    await expect(
      listAllResources(client, { deadline: createDeadlineClock(0) }),
    ).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
    expect(cursors).toEqual([]);
  });

  it('is transactional: a mid-pagination failure yields no partial list', async () => {
    const { client } = pageClient(
      [
        { resources: [resource('a')], nextCursor: 'c1' },
        { resources: [resource('b')], nextCursor: 'c2' },
        { resources: [resource('c')], nextCursor: null },
      ],
      { failOnPage: 3, failWith: new Error('network reset') },
    );
    await expect(
      listAllResources(client, { deadline: createDeadlineClock(5000) }),
    ).rejects.toThrow('network reset');
  });

  it('emits one debug line per page when a sink is provided', async () => {
    const { client } = pageClient([
      { resources: [resource('a')], nextCursor: 'c1' },
      { resources: [resource('b')], nextCursor: null },
    ]);
    const lines: string[] = [];
    await listAllResources(client, {
      deadline: createDeadlineClock(5000),
      debugLog: (m) => lines.push(m),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('resources/list page=1');
    expect(lines[1]).toContain('nextCursor=<end>');
  });
});

describe('readResource (single fetch)', () => {
  it('reads one resource under the deadline', async () => {
    const { client, reads } = pageClient([{ resources: [] }]);
    const contents = await readResource(client, 'file:///a.txt', createDeadlineClock(5000));
    expect(contents).toEqual([{ uri: 'file:///a.txt', text: 'content of file:///a.txt' }]);
    expect(reads).toEqual(['file:///a.txt']);
  });

  it('rejects an empty uri as a protocol error', async () => {
    const { client } = pageClient([{ resources: [] }]);
    await expect(readResource(client, '', createDeadlineClock(5000))).rejects.toBeInstanceOf(
      McpError,
    );
  });

  it('throws MCP_TIMEOUT without calling the server when already expired', async () => {
    const { client, reads } = pageClient([{ resources: [] }]);
    await expect(readResource(client, 'file:///a.txt', createDeadlineClock(0))).rejects.toMatchObject({
      code: 'MCP_TIMEOUT',
    });
    expect(reads).toEqual([]);
  });
});

describe('capability predicates', () => {
  it('detects resources and prompts from the initialize result', () => {
    expect(serverSupportsResources({ resources: { listChanged: true } })).toBe(true);
    expect(serverSupportsResources({ tools: {} })).toBe(false);
    expect(serverSupportsResources(undefined)).toBe(false);
    expect(serverSupportsPrompts({ prompts: {} })).toBe(true);
    expect(serverSupportsPrompts({ resources: {} })).toBe(false);
  });
});
