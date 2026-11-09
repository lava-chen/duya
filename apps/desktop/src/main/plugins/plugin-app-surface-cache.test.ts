/**
 * The surface cache decides when a launch may skip the MCP resource read.
 * Both directions matter: a hit must return the exact document that was
 * stored, and a miss must never return another surface's document.
 */
import { describe, expect, it } from 'vitest';
import { PluginAppSurfaceCache, type SurfaceCacheKey } from './plugin-app-surface-cache';

const base: SurfaceCacheKey = {
  pluginId: 'acme.notes',
  appId: 'board',
  surfaceId: 'default',
  server: 'notes',
  resourceUri: 'ui://board/index.html',
};

function key(overrides: Partial<SurfaceCacheKey> = {}): SurfaceCacheKey {
  return { ...base, ...overrides };
}

describe('PluginAppSurfaceCache', () => {
  it('misses before a document is stored and hits afterwards', () => {
    const cache = new PluginAppSurfaceCache();
    expect(cache.get(base)).toBeUndefined();
    cache.set(base, '<html>board</html>');
    expect(cache.get(base)).toBe('<html>board</html>');
  });

  it('keeps one entry per distinct surface identity', () => {
    const cache = new PluginAppSurfaceCache();
    cache.set(key({ surfaceId: 'board' }), 'board');
    cache.set(key({ surfaceId: 'list' }), 'list');
    // Same App, different server: the document comes from the other server.
    cache.set(key({ server: 'other' }), 'other');

    expect(cache.get(key({ surfaceId: 'board' }))).toBe('board');
    expect(cache.get(key({ surfaceId: 'list' }))).toBe('list');
    expect(cache.get(key({ server: 'other' }))).toBe('other');
    expect(cache.get(key({ surfaceId: 'missing' }))).toBeUndefined();
  });

  it('replaces rather than accumulates when the same key is stored twice', () => {
    const cache = new PluginAppSurfaceCache();
    cache.set(base, 'first');
    cache.set(base, 'second');
    expect(cache.size).toBe(1);
    expect(cache.get(base)).toBe('second');
    expect(cache.bytes).toBe(Buffer.byteLength('second', 'utf8'));
  });

  it('evicts the least recently used entry when entries overflow', () => {
    const cache = new PluginAppSurfaceCache({ maxEntries: 2 });
    cache.set(key({ surfaceId: 'a' }), 'a');
    cache.set(key({ surfaceId: 'b' }), 'b');
    // Reading `a` makes `b` the eviction candidate.
    expect(cache.get(key({ surfaceId: 'a' }))).toBe('a');
    cache.set(key({ surfaceId: 'c' }), 'c');

    expect(cache.get(key({ surfaceId: 'b' }))).toBeUndefined();
    expect(cache.get(key({ surfaceId: 'a' }))).toBe('a');
    expect(cache.get(key({ surfaceId: 'c' }))).toBe('c');
  });

  it('evicts on the byte budget, not only on the entry count', () => {
    const cache = new PluginAppSurfaceCache({ maxBytes: 10 });
    cache.set(key({ surfaceId: 'a' }), 'aaaaaa');
    cache.set(key({ surfaceId: 'b' }), 'bbbbbb');
    // 12 bytes total exceeds the 10-byte budget; the older entry goes first.
    expect(cache.get(key({ surfaceId: 'a' }))).toBeUndefined();
    expect(cache.get(key({ surfaceId: 'b' }))).toBe('bbbbbb');
    expect(cache.bytes).toBe(6);
  });

  it('refuses a document larger than the whole budget', () => {
    const cache = new PluginAppSurfaceCache({ maxBytes: 4 });
    cache.set(key({ surfaceId: 'big' }), 'too large');
    // Caching it would evict everything else to hold one item.
    expect(cache.size).toBe(0);
    expect(cache.get(key({ surfaceId: 'big' }))).toBeUndefined();
  });

  it('drops only the changed plugin on invalidation', () => {
    const cache = new PluginAppSurfaceCache();
    cache.set(key({ pluginId: 'acme.notes' }), 'notes');
    cache.set(key({ pluginId: 'acme.charts', appId: 'chart' }), 'charts');

    cache.clearPlugin('acme.notes');

    expect(cache.get(key({ pluginId: 'acme.notes' }))).toBeUndefined();
    expect(cache.get(key({ pluginId: 'acme.charts', appId: 'chart' }))).toBe('charts');
    expect(cache.bytes).toBe(Buffer.byteLength('charts', 'utf8'));
  });

  it('forgets every document on clear', () => {
    const cache = new PluginAppSurfaceCache();
    cache.set(key(), 'one');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('PluginAppSurfaceCache expiry', () => {
  it('keeps serving a document until the shelf life runs out', () => {
    let now = 1_000;
    const cache = new PluginAppSurfaceCache({ ttlMs: 60_000, now: () => now });
    cache.set(base, '<html>board</html>');

    now += 59_999;
    expect(cache.get(base)).toBe('<html>board</html>');

    // Past the TTL the read has to happen again: a plugin's MCP server can
    // serve new HTML without any manifest change.
    now += 1;
    expect(cache.get(base)).toBeUndefined();
  });

  it('drops the expired entry instead of holding its bytes', () => {
    let now = 0;
    const cache = new PluginAppSurfaceCache({ ttlMs: 10, now: () => now });
    cache.set(base, 'board');

    now = 10;
    expect(cache.get(base)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('does not extend the shelf life on a hit', () => {
    let now = 0;
    const cache = new PluginAppSurfaceCache({ ttlMs: 100, now: () => now });
    cache.set(base, 'board');

    now = 60;
    expect(cache.get(base)).toBe('board');
    // The document was stored at 0, so it expires at 100 regardless of reads.
    now = 100;
    expect(cache.get(base)).toBeUndefined();
  });
});
