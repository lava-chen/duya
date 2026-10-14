/**
 * Prompt Cache Management
 * Provides LRU caching for computed prompt sections with observability
 */

import type { ResolvedPromptSection } from './types.js'

/**
 * Cache entry with metadata for LRU and observability
 */
interface CacheEntry {
  value: string | null
  cachedAt: number
  accessCount: number
  lastAccessedAt: number
}

/**
 * Cache statistics for monitoring hit rates
 */
export interface CacheStats {
  hits: number
  misses: number
  evictions: number
  totalAccesses: number
  hitRate: number
  size: number
  maxSize: number
}

/**
 * Enhanced Prompt Cache with LRU eviction and statistics.
 *
 * Static (non-volatile) sections are cached until explicitly cleared.
 * Volatile sections are never cached.
 */
export class PromptCache {
  private cache: Map<string, CacheEntry> = new Map()
  private resolvedSections: ResolvedPromptSection[] = []
  private maxSize: number

  private readonly stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    totalAccesses: 0,
  }

  constructor(maxSize = 50) {
    this.maxSize = maxSize
  }

  /**
   * Get a cached value if it exists.
   * Updates LRU order and statistics.
   */
  get(key: string): string | null | undefined {
    this.stats.totalAccesses++
    const entry = this.cache.get(key)

    if (entry === undefined) {
      this.stats.misses++
      return undefined
    }

    this.stats.hits++
    entry.accessCount++
    entry.lastAccessedAt = Date.now()

    // Move to end (MRU position) for LRU ordering
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  /**
   * Set a cached value.
   * Evicts oldest entry if at capacity.
   */
  set(key: string, value: string | null): void {
    // Evict oldest (first) entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value
      if (typeof oldestKey === 'string') {
        this.cache.delete(oldestKey)
        this.stats.evictions++
      }
    }

    this.cache.set(key, {
      value,
      cachedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
    })
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      ...this.stats,
      hitRate: total > 0 ? (this.stats.hits / total) * 100 : 0,
      size: this.cache.size,
      maxSize: this.maxSize,
    }
  }

  /**
   * Clear all cached sections and reset statistics.
   * Call this when session state changes that affects prompts.
   */
  clear(): void {
    this.cache.clear()
    this.resolvedSections = []
    this.stats.hits = 0
    this.stats.misses = 0
    this.stats.evictions = 0
    this.stats.totalAccesses = 0
  }

  /**
   * Get all cached section names.
   */
  keys(): IterableIterator<string> {
    return this.cache.keys()
  }

  /**
   * Store the resolved sections for later retrieval.
   */
  storeResolved(sections: ResolvedPromptSection[]): void {
    this.resolvedSections = sections
  }

  /**
   * Get all resolved sections.
   */
  getResolved(): ResolvedPromptSection[] {
    return this.resolvedSections
  }

  /**
   * Get a specific resolved section by name.
   */
  getResolvedSection(name: string): ResolvedPromptSection | undefined {
    return this.resolvedSections.find((s) => s.name === name)
  }
}

/**
 * Create a new prompt cache instance.
 */
export function createPromptCache(maxSize?: number): PromptCache {
  return new PromptCache(maxSize)
}
