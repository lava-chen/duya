export { KnownMarketplacesManager, getKnownMarketplacesManager } from './known-marketplaces-manager';
export { isBlockedMarketplaceName } from './impersonation-detector';
export { CatalogCache, getCatalogCache } from './catalog-cache';
export { CatalogFetcher, getCatalogFetcher } from './catalog-fetcher';
export { PolicyManager, getPolicyManager } from './policy-manager';
export { MarketplaceSyncManager, getMarketplaceSyncManager } from './sync-manager';
export type {
  MarketplaceEntry,
  KnownMarketplacesFile,
  MarketplacePluginSource,
  MarketplacePluginEntry,
  MarketplaceCatalog,
  CachedMarketplaceCatalog,
  MarketplacePolicy,
} from './types';