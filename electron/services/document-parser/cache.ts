import type { ParseResult } from './types';

export interface DocumentCache {
  get(fileHash: string): ParseResult | undefined;
  set(fileHash: string, result: ParseResult): void;
  remove(fileHash: string): void;
  clearBySession(sessionId: string): void;
  clearExpired(maxAgeMs: number): void;
}

export function createDocumentCache(): DocumentCache {
  const store = new Map<string, ParseResult>();

  return {
    get(fileHash: string): ParseResult | undefined {
      return store.get(fileHash);
    },

    set(fileHash: string, result: ParseResult): void {
      store.set(fileHash, result);
    },

    remove(fileHash: string): void {
      store.delete(fileHash);
    },

    clearBySession(sessionId: string): void {
      for (const [key, value] of store) {
        if (value.sessionId === sessionId) {
          store.delete(key);
        }
      }
    },

    clearExpired(maxAgeMs: number): void {
      const now = Date.now();
      for (const [key, value] of store) {
        if (now - value.parsedAt > maxAgeMs) {
          store.delete(key);
        }
      }
    },
  };
}