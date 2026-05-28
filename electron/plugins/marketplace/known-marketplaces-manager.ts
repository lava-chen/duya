import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import type { MarketplaceEntry, KnownMarketplacesFile } from './types';

const COMPONENT = 'KnownMarketplaces' as LogComponent;

const DEFAULT_MARKETPLACES: KnownMarketplacesFile = {
  version: 1,
  marketplaces: {
    'duya-official': {
      name: 'DUYA Official Marketplace',
      url: 'https://raw.githubusercontent.com/lava-chen/duya-marketplace/main/marketplace.json',
      description: 'Official DUYA plugin marketplace',
      autoUpdate: true,
      trusted: true,
    },
  },
};

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(targetPath: string, payload: unknown): void {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
}

export class KnownMarketplacesManager {
  private readonly logger = getLogger();
  private readonly filePath: string;

  constructor() {
    const userData = app.getPath('userData');
    const marketDir = path.join(userData, 'marketplaces');
    ensureDir(marketDir);
    this.filePath = path.join(marketDir, 'known_marketplaces.json');

    if (!fs.existsSync(this.filePath)) {
      this.writeFile(DEFAULT_MARKETPLACES);
      this.logger.info('Created default known_marketplaces.json', undefined, COMPONENT);
    }
  }

  private readFile(): KnownMarketplacesFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as KnownMarketplacesFile;
      if (parsed.version !== 1 || typeof parsed.marketplaces !== 'object') {
        return this.resetToDefaults();
      }
      return parsed;
    } catch {
      return this.resetToDefaults();
    }
  }

  private writeFile(file: KnownMarketplacesFile): void {
    atomicWriteJson(this.filePath, file);
  }

  private resetToDefaults(): KnownMarketplacesFile {
    this.writeFile(DEFAULT_MARKETPLACES);
    return { ...DEFAULT_MARKETPLACES, marketplaces: { ...DEFAULT_MARKETPLACES.marketplaces } };
  }

  getAll(): Record<string, MarketplaceEntry> {
    return this.readFile().marketplaces;
  }

  get(key: string): MarketplaceEntry | null {
    return this.readFile().marketplaces[key] ?? null;
  }

  add(key: string, entry: MarketplaceEntry): boolean {
    const file = this.readFile();
    if (file.marketplaces[key]) {
      return false;
    }
    file.marketplaces[key] = entry;
    this.writeFile(file);
    this.logger.info('Marketplace added', { key, url: entry.url }, COMPONENT);
    return true;
  }

  update(key: string, entry: Partial<MarketplaceEntry>): boolean {
    const file = this.readFile();
    const existing = file.marketplaces[key];
    if (!existing) {
      return false;
    }
    file.marketplaces[key] = { ...existing, ...entry };
    this.writeFile(file);
    this.logger.info('Marketplace updated', { key }, COMPONENT);
    return true;
  }

  remove(key: string): boolean {
    const file = this.readFile();
    if (!file.marketplaces[key]) {
      return false;
    }
    delete file.marketplaces[key];
    this.writeFile(file);
    this.logger.info('Marketplace removed', { key }, COMPONENT);
    return true;
  }

  setEnabled(key: string, enabled: boolean): boolean {
    return this.update(key, { autoUpdate: enabled } as Partial<MarketplaceEntry>);
  }

  reset(): KnownMarketplacesFile {
    this.writeFile(DEFAULT_MARKETPLACES);
    this.logger.info('Marketplaces reset to defaults', undefined, COMPONENT);
    return this.readFile();
  }
}

let knownMarketplacesManagerSingleton: KnownMarketplacesManager | null = null;

export function getKnownMarketplacesManager(): KnownMarketplacesManager {
  if (!knownMarketplacesManagerSingleton) {
    knownMarketplacesManagerSingleton = new KnownMarketplacesManager();
  }
  return knownMarketplacesManagerSingleton;
}