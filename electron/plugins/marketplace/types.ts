export interface MarketplaceEntry {
  name: string;
  url: string;
  description?: string;
  autoUpdate: boolean;
  trusted?: boolean;
}

export interface KnownMarketplacesFile {
  version: 1;
  marketplaces: Record<string, MarketplaceEntry>;
}

export interface MarketplacePluginSource {
  type: 'github' | 'url' | 'local';
  repo?: string;
  subdir?: string | null;
  url?: string;
}

export interface MarketplacePluginEntry {
  name: string;
  description: string;
  version: string;
  source: MarketplacePluginSource;
  author: {
    name: string;
    email?: string;
    url?: string;
  };
  categories: string[];
  tags: string[];
  minDuyaVersion?: string;
  homepage?: string;
  icon?: string;
}

export interface MarketplaceCatalog {
  name: string;
  version: number;
  plugins: Record<string, MarketplacePluginEntry>;
  updatedAt?: string;
}

export interface CachedMarketplaceCatalog {
  name: string;
  url: string;
  catalog: MarketplaceCatalog;
  etag: string | null;
  fetchedAt: string;
}

export interface MarketplacePolicy {
  strictKnownMarketplaces?: boolean;
  allowedMarketplaces?: string[];
  blockedMarketplaces?: string[];
  blockedPlugins?: string[];
  allowedPluginSources?: Array<'github' | 'url' | 'local'>;
}