import * as path from 'path';
import * as fs from 'fs';
import { getCacheDir } from '../utils/cacheDir.js';

export interface DocumentCacheEntry {
  parsedText?: string;
  images?: string[];
}

const CACHE_SUBDIR = 'document-attachments';

function resolveCachePath(key: string): string {
  return path.join(getCacheDir(CACHE_SUBDIR), `${key}.json`);
}

class DocumentCache {
  private memory = new Map<string, DocumentCacheEntry>();

  store(key: string, entry: DocumentCacheEntry): void {
    this.memory.set(key, entry);
    try {
      const filePath = resolveCachePath(key);
      fs.writeFileSync(filePath, JSON.stringify(entry), 'utf-8');
    } catch {
      // disk write is best-effort
    }
  }

  get(key: string): DocumentCacheEntry | undefined {
    const mem = this.memory.get(key);
    if (mem) return mem;

    try {
      const filePath = resolveCachePath(key);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(raw) as DocumentCacheEntry;
        this.memory.set(key, entry);
        return entry;
      }
    } catch {
      // disk read is best-effort
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.memory.has(key) || fs.existsSync(resolveCachePath(key));
  }
}

export const documentCache = new DocumentCache();