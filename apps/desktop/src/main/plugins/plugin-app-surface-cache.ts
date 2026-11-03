/**
 * Surface document cache — stop re-reading an unchanged MCP resource on every
 * launch.
 *
 * A surface App's HTML comes from an MCP resource read: agent server → worker,
 * with a standalone-client fallback. That path is the slowest part of opening
 * an App that has already been opened once, and the document only changes when
 * the plugin does.
 *
 * The cache is keyed on everything the read depends on — plugin, App, surface,
 * server and resource URI — so two surfaces can never see each other's
 * document. It is bounded in both entries and bytes (one document may be up to
 * `PLUGIN_UI_RESOURCE_MAX_BYTES`) and evicts least-recently-used first.
 *
 * Entries also expire. A plugin change is the normal reason a document
 * changes, and that invalidates by plugin id; but a plugin's MCP server can
 * serve different HTML after its own restart without any manifest change, and
 * a cache with no shelf life would pin that first document for the whole
 * session. A short TTL keeps the win — reopening an App you were just using —
 * while bounding how long a live-edited surface can stay stale.
 *
 * Invalidation is by plugin: a reinstall, enable, disable or upgrade of that
 * plugin drops every entry the plugin owns. Nothing here outlives the process,
 * so a restart always re-reads.
 */

export interface SurfaceCacheKey {
  pluginId: string;
  appId: string;
  surfaceId: string;
  server: string;
  resourceUri: string;
}

/** Matches the cap the read path already enforces on one document. */
export const DEFAULT_SURFACE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_SURFACE_CACHE_MAX_ENTRIES = 32;
/**
 * How long one document may be reused.
 *
 * Long enough to cover close-and-reopen and tab switching, short enough that a
 * surface edited on the server side is picked up without reinstalling.
 */
export const DEFAULT_SURFACE_CACHE_TTL_MS = 60_000;

function keyOf(key: SurfaceCacheKey): string {
  return [key.pluginId, key.appId, key.surfaceId, key.server, key.resourceUri].join('\u0000');
}

export interface SurfaceCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
}

interface SurfaceCacheEntry {
  pluginId: string;
  html: string;
  bytes: number;
  storedAt: number;
}

export class PluginAppSurfaceCache {
  readonly #entries = new Map<string, SurfaceCacheEntry>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #bytes = 0;

  constructor(options: SurfaceCacheOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_SURFACE_CACHE_MAX_BYTES;
    this.#maxEntries = options.maxEntries ?? DEFAULT_SURFACE_CACHE_MAX_ENTRIES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SURFACE_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The cached document, refreshed to most-recently-used. */
  get(key: SurfaceCacheKey): string | undefined {
    const id = keyOf(key);
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (this.#now() - entry.storedAt >= this.#ttlMs) {
      this.#bytes -= entry.bytes;
      this.#entries.delete(id);
      return undefined;
    }
    // Re-insert to move it to the tail of the LRU order.
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry.html;
  }

  /**
   * Store one validated document.
   *
   * A document larger than the whole budget is not cached — caching it would
   * evict everything else to hold one item.
   */
  set(key: SurfaceCacheKey, html: string): void {
    const id = keyOf(key);
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > this.#maxBytes) return;

    const existing = this.#entries.get(id);
    if (existing) {
      this.#bytes -= existing.bytes;
      this.#entries.delete(id);
    }
    this.#entries.set(id, { pluginId: key.pluginId, html, bytes, storedAt: this.#now() });
    this.#bytes += bytes;
    this.#evict();
  }

  /** Drop every document belonging to one plugin. */
  clearPlugin(pluginId: string): void {
    for (const [id, entry] of [...this.#entries]) {
      if (entry.pluginId !== pluginId) continue;
      this.#bytes -= entry.bytes;
      this.#entries.delete(id);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      const entry = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (entry) this.#bytes -= entry.bytes;
    }
  }
}
