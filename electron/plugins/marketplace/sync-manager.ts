import { getLogger, LogComponent } from '../../logging/logger';
import { getKnownMarketplacesManager } from './known-marketplaces-manager';
import { getCatalogFetcher } from './catalog-fetcher';
import { getCatalogCache } from './catalog-cache';
import type { MarketplaceCatalog } from './types';

const COMPONENT = 'MarketplaceSync' as LogComponent;

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MarketplaceUpdate {
  key: string;
  name: string;
  hasUpdate: boolean;
  error?: string;
}

export class MarketplaceSyncManager {
  private readonly logger = getLogger();
  private readonly fetcher = getCatalogFetcher();
  private readonly cache = getCatalogCache();
  private preloaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  async preloadCatalogs(): Promise<Map<string, MarketplaceCatalog>> {
    if (this.preloaded) {
      const result = new Map<string, MarketplaceCatalog>();
      const manager = getKnownMarketplacesManager();
      const marketplaces = manager.getAll();
      for (const [key] of Object.entries(marketplaces)) {
        const cached = this.fetcher.getCached(key);
        if (cached) {
          result.set(key, cached);
        }
      }
      return result;
    }

    const manager = getKnownMarketplacesManager();
    const marketplaces = manager.getAll();
    const result = new Map<string, MarketplaceCatalog>();

    const entries = Object.entries(marketplaces);

    for (const [key, entry] of entries) {
      try {
        const { catalog } = await this.fetcher.fetchCatalog(key, entry.url);
        result.set(key, catalog);
      } catch (err) {
        const cached = this.fetcher.getCached(key);
        if (cached) {
          result.set(key, cached);
          this.logger.warn('Using cached catalog after fetch failure', { key }, COMPONENT);
        } else if (err instanceof Error && err.name === 'AbortError') {
          this.logger.warn('Marketplace catalog fetch timed out', { key, url: entry.url }, COMPONENT);
        } else {
          const is404 = err instanceof Error && err.message.includes('HTTP 404');
          if (is404) {
            this.logger.warn('Marketplace catalog not available (404)', { key, url: entry.url }, COMPONENT);
          } else {
            this.logger.error('Failed to preload marketplace catalog', err instanceof Error ? err : new Error(String(err)), { key }, COMPONENT);
          }
        }
      }
    }

    this.preloaded = true;
    this.logger.info('Marketplace catalogs preloaded', { count: result.size }, COMPONENT);
    return result;
  }

  async checkForUpdates(): Promise<MarketplaceUpdate[]> {
    const manager = getKnownMarketplacesManager();
    const marketplaces = manager.getAll();
    const updates: MarketplaceUpdate[] = [];

    for (const [key, entry] of Object.entries(marketplaces)) {
      try {
        const cached = this.cache.get(key);
        if (!cached) {
          updates.push({ key, name: entry.name, hasUpdate: true });
          continue;
        }

        const { catalog, etag } = await this.fetcher.fetchCatalog(key, entry.url);
        const hasUpdate = etag !== cached.etag || catalog.version !== cached.catalog.version;
        updates.push({ key, name: entry.name, hasUpdate });
      } catch (err) {
        updates.push({
          key,
          name: entry.name,
          hasUpdate: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return updates;
  }

  async syncMarketplace(key: string): Promise<MarketplaceCatalog> {
    const manager = getKnownMarketplacesManager();
    const entry = manager.get(key);
    if (!entry) {
      throw new Error(`Marketplace "${key}" not found in known marketplaces`);
    }

    const { catalog } = await this.fetcher.fetchCatalogForce(key, entry.url);
    return catalog;
  }

  startAutoSync(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.checkForUpdates().catch((err) => {
        this.logger.error('Auto-sync check failed', err instanceof Error ? err : new Error(String(err)), undefined, COMPONENT);
      });
    }, SYNC_INTERVAL_MS);

    this.logger.info('Marketplace auto-sync started', { intervalMs: SYNC_INTERVAL_MS }, COMPONENT);
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Marketplace auto-sync stopped', undefined, COMPONENT);
    }
  }

  addLocalDir(_name: string, _dir: string): void {
    throw new Error('--add-dir is not yet implemented');
  }
}

let syncManagerSingleton: MarketplaceSyncManager | null = null;

export function getMarketplaceSyncManager(): MarketplaceSyncManager {
  if (!syncManagerSingleton) {
    syncManagerSingleton = new MarketplaceSyncManager();
  }
  return syncManagerSingleton;
}