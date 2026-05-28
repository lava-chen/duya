import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import type { CachedMarketplaceCatalog, MarketplaceCatalog } from './types';

const COMPONENT = 'CatalogCache' as LogComponent;

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class CatalogCache {
  private readonly logger = getLogger();
  private readonly cacheDir: string;

  constructor() {
    const userData = app.getPath('userData');
    this.cacheDir = path.join(userData, 'cache', 'marketplaces');
    ensureDir(this.cacheDir);
  }

  get(name: string): CachedMarketplaceCatalog | null {
    const filePath = this.filePath(name);
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as CachedMarketplaceCatalog;
    } catch {
      this.logger.warn('Failed to read marketplace cache', { name }, COMPONENT);
      return null;
    }
  }

  set(name: string, url: string, catalog: MarketplaceCatalog, etag: string | null): void {
    const cached: CachedMarketplaceCatalog = {
      name,
      url,
      catalog,
      etag,
      fetchedAt: new Date().toISOString(),
    };
    const filePath = this.filePath(name);
    fs.writeFileSync(filePath, JSON.stringify(cached, null, 2), 'utf8');
    this.logger.debug('Marketplace catalog cached', { name }, COMPONENT);
  }

  remove(name: string): void {
    const filePath = this.filePath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  clear(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      this.logger.info('Marketplace cache cleared', undefined, COMPONENT);
    } catch (err) {
      this.logger.error('Failed to clear marketplace cache', err instanceof Error ? err : new Error(String(err)), undefined, COMPONENT);
    }
  }

  private filePath(name: string): string {
    return path.join(this.cacheDir, `${sanitizeFileName(name)}.json`);
  }
}

let catalogCacheSingleton: CatalogCache | null = null;

export function getCatalogCache(): CatalogCache {
  if (!catalogCacheSingleton) {
    catalogCacheSingleton = new CatalogCache();
  }
  return catalogCacheSingleton;
}