import { getLogger, LogComponent } from '../../logging/logger';
import type { MarketplaceEntry, KnownMarketplacesFile } from './types';
import { getConfigStore } from '../../config/store-instance';

const COMPONENT = 'KnownMarketplaces' as LogComponent;

// Plan 334 decision 12: marketplace sources are migrged from
// `known_marketplaces.json` into the ConfigStore `marketplaces` block.
// The legacy file is deleted by Phase 3 migration; there is no file
// fallback.

const DEFAULT_MARKETPLACES: Record<string, MarketplaceEntry> = {
  'duya-official': {
    name: 'DUYA Official Marketplace',
    url: 'https://raw.githubusercontent.com/lava-chen/duya-marketplace/main/marketplace.json',
    description: 'Official DUYA plugin marketplace',
    autoUpdate: true,
    trusted: true,
  },
};

export class KnownMarketplacesManager {
  private readonly logger = getLogger();

  private readMarketplaces(): Record<string, MarketplaceEntry> {
    const marketplaces = getConfigStore().getByPath('marketplaces');
    if (marketplaces && typeof marketplaces === 'object') {
      return marketplaces as Record<string, MarketplaceEntry>;
    }
    return {};
  }

  private writeMarketplaces(marketplaces: Record<string, MarketplaceEntry>): void {
    getConfigStore().set('marketplaces', marketplaces);
  }

  getAll(): Record<string, MarketplaceEntry> {
    const marketplaces = this.readMarketplaces();
    return Object.keys(marketplaces).length > 0 ? marketplaces : { ...DEFAULT_MARKETPLACES };
  }

  get(key: string): MarketplaceEntry | null {
    return this.getAll()[key] ?? null;
  }

  add(key: string, entry: MarketplaceEntry): boolean {
    const marketplaces = this.readMarketplaces();
    if (marketplaces[key]) {
      return false;
    }
    marketplaces[key] = entry;
    this.writeMarketplaces(marketplaces);
    this.logger.info('Marketplace added', { key, url: entry.url }, COMPONENT);
    return true;
  }

  update(key: string, entry: Partial<MarketplaceEntry>): boolean {
    const marketplaces = this.readMarketplaces();
    const existing = marketplaces[key];
    if (!existing) {
      return false;
    }
    marketplaces[key] = { ...existing, ...entry };
    this.writeMarketplaces(marketplaces);
    this.logger.info('Marketplace updated', { key }, COMPONENT);
    return true;
  }

  remove(key: string): boolean {
    const marketplaces = this.readMarketplaces();
    if (!marketplaces[key]) {
      return false;
    }
    delete marketplaces[key];
    this.writeMarketplaces(marketplaces);
    this.logger.info('Marketplace removed', { key }, COMPONENT);
    return true;
  }

  setEnabled(key: string, enabled: boolean): boolean {
    return this.update(key, { autoUpdate: enabled } as Partial<MarketplaceEntry>);
  }

  reset(): KnownMarketplacesFile {
    this.writeMarketplaces({ ...DEFAULT_MARKETPLACES });
    this.logger.info('Marketplaces reset to defaults', undefined, COMPONENT);
    return { version: 1, marketplaces: { ...DEFAULT_MARKETPLACES } };
  }
}

let knownMarketplacesManagerSingleton: KnownMarketplacesManager | null = null;

export function getKnownMarketplacesManager(): KnownMarketplacesManager {
  if (!knownMarketplacesManagerSingleton) {
    knownMarketplacesManagerSingleton = new KnownMarketplacesManager();
  }
  return knownMarketplacesManagerSingleton;
}