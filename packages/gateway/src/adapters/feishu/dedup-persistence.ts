// @ts-nocheck
/**
 * Feishu Message Deduplication Persistence
 *
 * Persists seen message IDs to disk for cross-restart deduplication.
 * Format: { msgId: timestamp } dictionary
 * TTL: 24 hours (configurable)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_SIZE = 2048;

interface DedupEntry {
  timestamp: number;
}

interface DedupStore {
  [msgId: string]: number;
}

export class DedupPersistence {
  private filePath: string;
  private store: DedupStore = {};
  private maxSize: number;
  private ttlMs: number;
  private dirty = false;
  private loaded = false;

  constructor(options?: { filePath?: string; maxSize?: number; ttlMs?: number }) {
    const home = os.homedir();
    const duyaDir = path.join(home, '.duya');
    this.filePath = options?.filePath ?? path.join(duyaDir, 'feishu_seen_message_ids.json');
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.ttlMs = options?.ttlMs ?? DEDUP_TTL_MS;
  }

  /** Load persisted store from disk */
  load(): void {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(content) as DedupStore;

        // Filter out expired entries
        const now = Date.now();
        for (const [msgId, timestamp] of Object.entries(data)) {
          if (now - timestamp > this.ttlMs) {
            delete data[msgId];
          } else {
            this.store[msgId] = timestamp;
          }
        }

        console.log(`[Feishu Dedup] Loaded ${Object.keys(this.store).length} entries from disk`);
      } else {
        console.log('[Feishu Dedup] No persisted file found, starting fresh');
      }
    } catch (err) {
      console.warn('[Feishu Dedup] Failed to load dedup store:', err);
      this.store = {};
    }

    this.loaded = true;
  }

  /** Save persisted store to disk */
  save(): void {
    if (!this.dirty) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to temp file then rename for atomicity
      const tempPath = this.filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.store), 'utf8');
      fs.renameSync(tempPath, this.filePath);
      this.dirty = false;
      console.log('[Feishu Dedup] Persisted to disk');
    } catch (err) {
      console.error('[Feishu Dedup] Failed to persist:', err);
    }
  }

  /** Check if message ID is duplicate, add if not */
  checkAndAdd(msgId: string): boolean {
    if (!this.loaded) this.load();

    const now = Date.now();

    // Check if expired
    const existing = this.store[msgId];
    if (existing !== undefined) {
      if (now - existing > this.ttlMs) {
        // Expired, treat as new
        delete this.store[msgId];
      } else {
        // Already seen (not expired)
        return true;
      }
    }

    // Add new entry
    this.store[msgId] = now;
    this.dirty = true;

    // Enforce max size with LRU eviction
    if (Object.keys(this.store).length > this.maxSize) {
      this.evictOldest();
    }

    // Debounced save (every 10 new entries)
    if (Object.keys(this.store).length % 10 === 0) {
      this.save();
    }

    return false;
  }

  /** Evict oldest entries to stay within max size */
  private evictOldest(): void {
    const entries = Object.entries(this.store)
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.floor(this.maxSize * 0.2)); // Evict oldest 20%

    for (const [msgId] of entries) {
      delete this.store[msgId];
    }

    console.log(`[Feishu Dedup] Evicted ${entries.length} old entries`);
  }

  /** Get count of stored entries */
  get size(): number {
    return Object.keys(this.store).length;
  }

  /** Force save on shutdown */
  flush(): void {
    this.save();
  }

  /** Get file path (for testing) */
  getFilePath(): string {
    return this.filePath;
  }
}

// Global instance
let globalInstance: DedupPersistence | null = null;

export function getDedupPersistence(): DedupPersistence {
  if (!globalInstance) {
    globalInstance = new DedupPersistence();
    globalInstance.load();
  }
  return globalInstance;
}

export function resetDedupPersistence(): void {
  if (globalInstance) {
    globalInstance.flush();
  }
  globalInstance = null;
}