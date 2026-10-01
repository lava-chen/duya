// packages/plugin-core/src/mcp/core/list-resources.ts
// Paginated `resources/list` aggregation + single-resource `resources/read`.
//
// `resources/list` is the SAME cursor protocol as `tools/list`, so it
// runs on the shared `paginateCursor` primitive and inherits the full
// contract: one deadline for the whole pass, cursor-ring detection,
// cross-page duplicate-URI detection, page/item caps, and a throw on any
// mid-pagination failure (the caller never observes a partial list).
//
// This is the data plane of MCP — files, DB rows, API snapshots. A
// client that only reads page one silently hides every resource past the
// server's first page, which is exactly the bug this module removes.

import { McpError } from './error-taxonomy.js';
import type { DeadlineClock } from './deadline.js';
import { paginateCursor, type PaginationTruncation } from './paginate.js';

/** Canonical resource descriptor, verbatim from the server. */
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  /** Server-defined size in bytes, when advertised. */
  size?: number;
  [key: string]: unknown;
}

/** One `contents` entry from a `resources/read` response. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

/** Structural subset of the MCP SDK Client's resources surface. */
export interface McpListResourcesClient {
  listResources(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ resources: McpResourceDescriptor[]; nextCursor?: string | null }>;
  readResource(
    params: { uri: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ contents: McpResourceContents[] }>;
}

export interface ListAllResourcesOptions {
  /** One shared deadline for the whole pagination pass. */
  deadline: DeadlineClock;
  /** Page-count cap. Default 50. */
  maxPages?: number;
  /** Resource-count cap. Default 2000. */
  maxResources?: number;
  /** Optional debug sink (env-gated by the caller). */
  debugLog?: (message: string) => void;
}

export interface ListAllResourcesResult {
  resources: McpResourceDescriptor[];
  pagesFetched: number;
  discoveredTotal: number;
  truncated: PaginationTruncation;
}

export const DEFAULT_MAX_RESOURCE_PAGES = 50;
export const DEFAULT_MAX_RESOURCES = 2000;

/**
 * Page through `resources/list` until the cursor is exhausted. Throws on
 * any failure so the caller can commit transactionally — a partial
 * resource list is never surfaced as a complete one.
 */
export async function listAllResources(
  client: McpListResourcesClient,
  opts: ListAllResourcesOptions,
): Promise<ListAllResourcesResult> {
  const result = await paginateCursor<McpResourceDescriptor>({
    deadline: opts.deadline,
    maxPages: opts.maxPages ?? DEFAULT_MAX_RESOURCE_PAGES,
    maxItems: opts.maxResources ?? DEFAULT_MAX_RESOURCES,
    ...(opts.debugLog ? { debugLog: opts.debugLog } : {}),
    method: 'resources/list',
    itemLabel: 'resource uri',
    keyOf: (r) => r.uri,
    fetchPage: async (cursor, remainingMs, signal) => {
      const page = await client.listResources(
        cursor !== undefined ? { cursor } : undefined,
        { timeout: remainingMs, signal },
      );
      return { items: page.resources, nextCursor: page.nextCursor };
    },
  });

  return {
    resources: result.items,
    pagesFetched: result.pagesFetched,
    discoveredTotal: result.discoveredTotal,
    truncated: result.truncated,
  };
}

/**
 * Read one resource under the SAME deadline discipline as discovery:
 * a single request rides `{ timeout, signal }` and a timeout never
 * closes the shared transport.
 */
export async function readResource(
  client: Pick<McpListResourcesClient, 'readResource'>,
  uri: string,
  deadline: DeadlineClock,
): Promise<McpResourceContents[]> {
  if (!uri) throw new McpError('MCP_PROTOCOL', 'resources/read requires a non-empty uri');
  deadline.throwIfExpired('resources/read');
  const result = await client.readResource(
    { uri },
    { timeout: deadline.remainingMs(), signal: deadline.signal },
  );
  return result.contents ?? [];
}

/** True when the server advertised the `resources` capability at initialize. */
export function serverSupportsResources(
  serverCapabilities: Record<string, unknown> | undefined,
): boolean {
  return !!serverCapabilities && typeof serverCapabilities.resources === 'object' && serverCapabilities.resources !== null;
}

/** True when the server advertised the `prompts` capability at initialize. */
export function serverSupportsPrompts(
  serverCapabilities: Record<string, unknown> | undefined,
): boolean {
  return !!serverCapabilities && typeof serverCapabilities.prompts === 'object' && serverCapabilities.prompts !== null;
}
