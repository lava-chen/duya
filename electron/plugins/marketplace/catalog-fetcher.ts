import { getLogger, LogComponent } from '../../logging/logger';
import { getCatalogCache } from './catalog-cache';
import type { MarketplaceCatalog } from './types';

const COMPONENT = 'CatalogFetcher' as LogComponent;

const FETCH_TIMEOUT_MS = 15_000;

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export class CatalogFetcher {
  private readonly logger = getLogger();
  private readonly cache = getCatalogCache();

  async fetchCatalog(name: string, url: string): Promise<{ catalog: MarketplaceCatalog; etag: string | null }> {
    const cached = this.cache.get(name);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    this.logger.debug('Fetching marketplace catalog', { name, url }, COMPONENT);

    const response = await fetch(url, {
      headers,
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (response.status === 304) {
      this.logger.debug('Marketplace catalog not modified', { name }, COMPONENT);
      return { catalog: cached!.catalog, etag: cached!.etag };
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch catalog from ${url}: HTTP ${response.status}`);
    }

    const etag = response.headers.get('ETag') || response.headers.get('etag');
    const raw = await response.json() as MarketplaceCatalog;

    const catalog = this.validateCatalog(raw, name);
    this.cache.set(name, url, catalog, etag);
    this.logger.info('Marketplace catalog fetched', { name, pluginCount: Object.keys(catalog.plugins).length }, COMPONENT);

    return { catalog, etag };
  }

  async fetchCatalogForce(name: string, url: string): Promise<{ catalog: MarketplaceCatalog; etag: string | null }> {
    this.logger.debug('Force-fetching marketplace catalog', { name, url }, COMPONENT);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch catalog from ${url}: HTTP ${response.status}`);
    }

    const etag = response.headers.get('ETag') || response.headers.get('etag');
    const raw = await response.json() as MarketplaceCatalog;

    const catalog = this.validateCatalog(raw, name);
    this.cache.set(name, url, catalog, etag);
    this.logger.info('Marketplace catalog force-fetched', { name, pluginCount: Object.keys(catalog.plugins).length }, COMPONENT);

    return { catalog, etag };
  }

  getCached(name: string): MarketplaceCatalog | null {
    const cached = this.cache.get(name);
    return cached?.catalog ?? null;
  }

  private validateCatalog(raw: MarketplaceCatalog, expectedName: string): MarketplaceCatalog {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid catalog: not an object');
    }
    if (typeof raw.name !== 'string') {
      throw new Error('Invalid catalog: missing "name" field');
    }
    if (typeof raw.version !== 'number') {
      throw new Error('Invalid catalog: missing "version" field');
    }
    if (!raw.plugins || typeof raw.plugins !== 'object') {
      throw new Error('Invalid catalog: missing "plugins" field');
    }

    for (const [key, plugin] of Object.entries(raw.plugins)) {
      if (typeof plugin !== 'object' || plugin === null) {
        throw new Error(`Invalid catalog: plugin "${key}" is not an object`);
      }
      const p = plugin as Record<string, unknown>;
      if (typeof p.name !== 'string' || typeof p.version !== 'string' || typeof p.description !== 'string') {
        throw new Error(`Invalid catalog: plugin "${key}" missing required fields`);
      }
    }

    return raw;
  }
}

let catalogFetcherSingleton: CatalogFetcher | null = null;

export function getCatalogFetcher(): CatalogFetcher {
  if (!catalogFetcherSingleton) {
    catalogFetcherSingleton = new CatalogFetcher();
  }
  return catalogFetcherSingleton;
}