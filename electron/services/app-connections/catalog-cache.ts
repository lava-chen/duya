/**
 * Per-connection tools/list snapshot cache (Plan 450 Phase E).
 *
 * Codex parity: `codex-mcp/src/mcp/mod.rs` exposes `CONNECTS_CACHE_TTL =
 * Duration::from_secs(3600)` and persists the connector directory
 * snapshot to disk so cold starts don't block on the remote server.
 *
 * Storage: one file per connection at
 * `{userData}/app-connections/catalog-cache/<connectionId>.json`. Atomic
 * write via tmp+rename so a crash mid-write never produces a half-baked
 * file. Reads return `null` for missing / malformed files; the caller
 * falls through to the live fetch.
 *
 * TTL: `CONNECTORS_CACHE_TTL_MS = 3_600_000` (1h). `isFresh` decides
 * whether the cache may be served as-is. Stale caches are NOT
 * auto-refreshed in the background — `listDescriptors` triggers a
 * foreground refresh and overwrites the snapshot; this keeps the model
 * path simple (no async race against an in-flight call).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { safeUserDataPath } from '../../logging/logger';

export const CONNECTORS_CACHE_TTL_MS = 3_600_000;

interface CachedSnapshot {
  fetchedAt: number;
  provider: string;
  /** Raw MCP `tools/list` response payload (tool definitions only). */
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: unknown;
  }>;
}

function cacheDir(): string {
  return path.join(safeUserDataPath(), 'app-connections', 'catalog-cache');
}

function cachePath(connectionId: string): string {
  return path.join(cacheDir(), `${connectionId}.json`);
}

function tmpPath(connectionId: string): string {
  return path.join(cacheDir(), `${connectionId}.json.tmp`);
}

/** Return the cached snapshot, or `null` when missing / malformed / wrong-shape. */
export function readCatalogCache(connectionId: string): CachedSnapshot | null {
  const path = cachePath(connectionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { fetchedAt?: unknown }).fetchedAt !== 'number' ||
    typeof (parsed as { provider?: unknown }).provider !== 'string' ||
    !Array.isArray((parsed as { tools?: unknown }).tools)
  ) {
    return null;
  }
  const tools = ((parsed as { tools: unknown[] }).tools).filter((t): t is CachedSnapshot['tools'][number] => {
    if (!t || typeof t !== 'object') return false;
    const name = (t as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0;
  });
  return {
    fetchedAt: (parsed as { fetchedAt: number }).fetchedAt,
    provider: (parsed as { provider: string }).provider,
    tools,
  };
}

/** Persist the raw MCP `tools/list` payload for a connection. */
export function writeCatalogCache(
  connectionId: string,
  provider: string,
  tools: CachedSnapshot['tools'],
): boolean {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[catalog-cache] mkdir failed', dir, err);
    return false;
  }
  const payload = JSON.stringify({ fetchedAt: Date.now(), provider, tools });
  const tmp = tmpPath(connectionId);
  const final = cachePath(connectionId);
  try {
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, final);
    return true;
  } catch (err) {
    console.error('[catalog-cache] write/rename failed', tmp, '->', final, err);
    return false;
  }
}

/** Remove the snapshot for a single connection (called on disconnect / revoke). */
export function deleteCatalogCache(connectionId: string): void {
  const final = cachePath(connectionId);
  const tmp = tmpPath(connectionId);
  for (const p of [final, tmp]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort cleanup; ignore transient locks (e.g. Windows)
    }
  }
}

/** True when the snapshot is at most `CONNECTORS_CACHE_TTL_MS` old. */
export function isFresh(snapshot: CachedSnapshot): boolean {
  return Date.now() - snapshot.fetchedAt <= CONNECTORS_CACHE_TTL_MS;
}