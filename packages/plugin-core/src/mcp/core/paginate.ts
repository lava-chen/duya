// packages/plugin-core/src/mcp/core/paginate.ts
// Shared, protocol-pure cursor-pagination primitive.
//
// `tools/list`, `resources/list` and `prompts/list` are the SAME wire
// shape with a different method name and item key. Duplicating the loop
// per method is how `listResources` ended up returning only page one:
// the shared contract (cursor-ring detection, cross-page duplicate
// detection, page/item caps, one deadline for the whole pass,
// transaction-on-failure) has exactly one implementation here so it
// cannot drift again.
//
// Contract:
//   - The aggregate is returned ONLY after the cursor is exhausted
//     normally; any mid-pagination failure throws and the temporary
//     inventory is discarded (the caller never sees a partial list).
//   - `seenCursors` ring detection -> MCP_PROTOCOL.
//   - cross-page duplicate keys -> MCP_PROTOCOL (never silently dedupe,
//     that would mask a server bug).
//   - `maxPages` / `maxItems` -> truncated result marked for `stale`.
//   - deadline expiry -> MCP_TIMEOUT.
//   - per-page deadline remaining + abort signal ride to the SDK, so a
//     shared transport is never closed for a single aborted request.

import { McpError } from './error-taxonomy.js';
import type { DeadlineClock } from './deadline.js';

/**
 * Truncation reasons. `maxTools` keeps the historical wire value even for
 * non-tool lists: `DiscoveryTruncation` is part of the public ledger
 * contract in both chains' `InventoryLedger`, so renaming it would be a
 * breaking change for no gain.
 */
export type PaginationTruncation = false | 'maxPages' | 'maxTools' | 'deadline';

export interface PaginateOptions<T> {
  /** One shared deadline for the whole pagination pass. */
  deadline: DeadlineClock;
  /** Page-count cap. */
  maxPages: number;
  /** Item-count cap across all pages. */
  maxItems: number;
  /** Optional debug sink (env-gated by the caller). */
  debugLog?: (message: string) => void;
  /** Protocol method label used in error/debug text, e.g. `tools/list`. */
  method: string;
  /** Noun used in the duplicate-item error, e.g. `tool name`. */
  itemLabel: string;
  /** Fetch one page. `cursor` is undefined for the first page. */
  fetchPage: (
    cursor: string | undefined,
    remainingMs: number,
    signal: AbortSignal,
  ) => Promise<{ items: T[] | undefined; nextCursor?: string | null }>;
  /** Stable identity for an item; duplicates across pages are a protocol error. */
  keyOf: (item: T) => string;
}

export interface PaginateResult<T> {
  items: T[];
  pagesFetched: number;
  /** Items actually discovered in THIS pass. */
  discoveredTotal: number;
  truncated: PaginationTruncation;
}

/**
 * Page until the cursor is exhausted. Throws on any failure — callers
 * commit the aggregate transactionally.
 */
export async function paginateCursor<T>(opts: PaginateOptions<T>): Promise<PaginateResult<T>> {
  const seenCursors = new Set<string>();
  const byKey = new Map<string, T>();
  let pagesFetched = 0;
  let cursor: string | undefined = undefined;
  let truncated: PaginationTruncation = false;

  while (true) {
    if (opts.deadline.isExpired()) {
      throw new McpError(
        'MCP_TIMEOUT',
        `${opts.method} pagination deadline exceeded after ${pagesFetched} page(s)`,
      );
    }

    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new McpError(
          'MCP_PROTOCOL',
          `${opts.method} pagination loop: cursor "${cursor}" already seen (page ${pagesFetched + 1})`,
        );
      }
      seenCursors.add(cursor);
    }

    const page = await opts.fetchPage(cursor, opts.deadline.remainingMs(), opts.deadline.signal);
    pagesFetched++;

    for (const item of page.items ?? []) {
      const key = opts.keyOf(item);
      if (byKey.has(key)) {
        throw new McpError(
          'MCP_PROTOCOL',
          `${opts.method} returned duplicate ${opts.itemLabel} "${key}" across pages (page ${pagesFetched})`,
        );
      }
      byKey.set(key, item);
    }

    opts.debugLog?.(
      `[mcp-discovery] ${opts.method} page=${pagesFetched} cursor=${cursor ?? '<none>'} batchItems=${page.items?.length ?? 0} totalSoFar=${byKey.size} nextCursor=${page.nextCursor ?? '<end>'}`,
    );

    if (page.nextCursor === null || page.nextCursor === undefined) break;

    if (pagesFetched >= opts.maxPages) {
      truncated = 'maxPages';
      opts.debugLog?.(`[mcp-discovery] maxPages=${opts.maxPages} reached; truncated`);
      break;
    }
    if (byKey.size >= opts.maxItems) {
      truncated = 'maxTools';
      opts.debugLog?.(`[mcp-discovery] maxItems=${opts.maxItems} reached; truncated`);
      break;
    }
    cursor = page.nextCursor;
  }

  return {
    items: [...byKey.values()],
    pagesFetched,
    discoveredTotal: byKey.size,
    truncated,
  };
}
