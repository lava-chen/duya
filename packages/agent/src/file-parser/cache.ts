/**
 * cache - in-memory parse result cache
 *
 * Mirrors electron/services/document-parser/cache.ts so the Electron
 * service layer can keep its existing cache instance. Hash is computed
 * by the caller (matches Python sidecar: first 64KB + filename + size).
 */

import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ParseResult } from './types.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ParseCache {
  get(fileHash: string): ParseResult | undefined;
  set(fileHash: string, result: ParseResult): void;
  remove(fileHash: string): void;
  clearBySession(sessionId: string): void;
  clearExpired(maxAgeMs?: number): void;
  size(): number;
}

export interface ParseCacheOptions {
  ttlMs?: number;
}

export function createParseCache(options: ParseCacheOptions = {}): ParseCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, ParseResult>();

  return {
    get(fileHash) {
      const entry = store.get(fileHash);
      if (!entry) return undefined;
      if (Date.now() - entry.parsedAt > ttlMs) {
        store.delete(fileHash);
        return undefined;
      }
      return entry;
    },
    set(fileHash, result) {
      store.set(fileHash, result);
    },
    remove(fileHash) {
      store.delete(fileHash);
    },
    clearBySession(sessionId) {
      for (const [key, value] of store) {
        if (value.sessionId === sessionId) store.delete(key);
      }
    },
    clearExpired(maxAgeMs = ttlMs) {
      const now = Date.now();
      for (const [key, value] of store) {
        if (now - value.parsedAt > maxAgeMs) store.delete(key);
      }
    },
    size() {
      return store.size;
    },
  };
}

/**
 * Compute a stable hash for cache keying.
 * Mirrors the Python sidecar and Electron DocumentParserService: first 64KB
 * + basename + size. Cheap O(64KB) and good enough for "did this file change?".
 */
export function computeFileHash(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    const fd = openSync(filePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      hash.update(buffer.subarray(0, bytesRead));
    } finally {
      closeSync(fd);
    }
  } catch {
    // fallback: hash basename + size only
  }
  hash.update(basename(filePath));
  hash.update(statSync(filePath).size.toString());
  return hash.digest('hex');
}
