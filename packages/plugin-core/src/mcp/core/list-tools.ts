// packages/plugin-core/src/mcp/core/list-tools.ts
// Plan 580 D3 — transactional paginated `tools/list` aggregation.
//
// Contract: the aggregate is returned ONLY after the server's cursor
// is exhausted normally; any mid-pagination failure throws and the
// temporary inventory is discarded (the caller never sees a partial
// list). Defensive guards:
//   - `seenCursors` ring detection → MCP_PROTOCOL,
//   - cross-page duplicate tool names → MCP_PROTOCOL (never silently
//     dedupe — that would mask a server bug),
//   - `maxPages` / `maxTools` → truncated result marked for `stale`,
//   - deadline expiry → MCP_TIMEOUT,
//   - per-page deadline remaining + abort signal ride to the SDK so a
//     shared transport is never closed for a single aborted request.

import { McpError } from './error-taxonomy.js';
import type { DeadlineClock } from './deadline.js';
import type { McpToolDescriptor } from './descriptor.js';
import { canonicalizeJson } from './descriptor.js';

/** Structural subset of the MCP SDK Client's listTools surface. */
export interface McpListToolsClient {
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string | null }>;
}

export interface ListAllToolsOptions {
  /** One shared deadline for the whole pagination pass. */
  deadline: DeadlineClock;
  /** Page-count cap. Default 50. */
  maxPages?: number;
  /** Tool-count cap. Default 5000. */
  maxTools?: number;
  /**
   * Caller-owned monotonic discovery generation. Echoed in the result;
   * the caller MUST verify it is unchanged before committing the
   * aggregate (late commits of a superseded discovery must lose).
   */
  generation: number;
  /** Optional debug sink (env-gated by the caller; plan 580 Phase 0). */
  debugLog?: (message: string) => void;
}

export type DiscoveryTruncation = false | 'maxPages' | 'maxTools' | 'deadline';

export interface ListAllToolsResult {
  tools: McpToolDescriptor[];
  pagesFetched: number;
  /**
   * The number of tools actually discovered in THIS pass. Not
   * "advertised" — a paginating server does not declare a total.
   */
  discoveredTotal: number;
  truncated: DiscoveryTruncation;
}

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_TOOLS = 5000;

/**
 * Plan 580 Phase 0: env-gated discovery debug instrumentation. When
 * `DUYA_MCP_DISCOVERY_DEBUG=1`, chains pass a `debugLog` sink into
 * `listAllTools` so every page logs `cursor/pages/total`. Uses the
 * SAME connection / OAuth grant as the real client (a separate client
 * could hit a different OAuth grant and show different totals).
 */
export function discoveryDebugEnabled(): boolean {
  return process.env.DUYA_MCP_DISCOVERY_DEBUG === '1';
}

/**
 * Page through `tools/list` until the cursor is exhausted. Throws on
 * any failure — callers commit the aggregate transactionally.
 */
export async function listAllTools(
  client: McpListToolsClient,
  opts: ListAllToolsOptions,
): Promise<ListAllToolsResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxTools = opts.maxTools ?? DEFAULT_MAX_TOOLS;

  const seenCursors = new Set<string>();
  const byName = new Map<string, McpToolDescriptor>();
  let pagesFetched = 0;
  let cursor: string | undefined = undefined;
  let truncated: DiscoveryTruncation = false;

  while (true) {
    if (opts.deadline.isExpired()) {
      throw new McpError('MCP_TIMEOUT', `tools/list pagination deadline exceeded after ${pagesFetched} page(s)`);
    }

    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new McpError(
          'MCP_PROTOCOL',
          `tools/list pagination loop: cursor "${cursor}" already seen (page ${pagesFetched + 1})`,
        );
      }
      seenCursors.add(cursor);
    }

    const timeoutMs = opts.deadline.remainingMs();
    const page = await client.listTools(
      cursor !== undefined ? { cursor } : undefined,
      { timeout: timeoutMs, signal: opts.deadline.signal },
    );
    pagesFetched++;

    for (const tool of page.tools ?? []) {
      if (byName.has(tool.name)) {
        throw new McpError(
          'MCP_PROTOCOL',
          `tools/list returned duplicate tool name "${tool.name}" across pages (page ${pagesFetched})`,
        );
      }
      byName.set(tool.name, tool);
    }

    opts.debugLog?.(
      `[mcp-discovery] page=${pagesFetched} cursor=${cursor ?? '<none>'} batchTools=${page.tools?.length ?? 0} totalSoFar=${byName.size} nextCursor=${page.nextCursor ?? '<end>'}`,
    );

    if (page.nextCursor === null || page.nextCursor === undefined) break;

    if (pagesFetched >= maxPages) {
      truncated = 'maxPages';
      opts.debugLog?.(`[mcp-discovery] maxPages=${maxPages} reached; truncated`);
      break;
    }
    if (byName.size >= maxTools) {
      truncated = 'maxTools';
      opts.debugLog?.(`[mcp-discovery] maxTools=${maxTools} reached; truncated`);
      break;
    }
    cursor = page.nextCursor;
  }

  return {
    tools: [...byName.values()],
    pagesFetched,
    discoveredTotal: byName.size,
    truncated,
  };
}

/**
 * Deterministic, bounded connection log line for a committed discovery
 * (plan 580 Phase 0 instrumentation, promoted in Phase 2A):
 * `pages=N, total=M`.
 */
export function formatDiscoveryLogLine(result: Pick<ListAllToolsResult, 'pagesFetched' | 'discoveredTotal' | 'truncated'>): string {
  const truncation = result.truncated ? ` (truncated: ${result.truncated})` : '';
  return `pages=${result.pagesFetched}, total=${result.discoveredTotal}${truncation}`;
}

/** Re-export so chains can canonicalize page payloads without extra imports. */
export { canonicalizeJson };
