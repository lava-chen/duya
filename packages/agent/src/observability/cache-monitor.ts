/**
 * Cache Hit Rate Monitor
 *
 * Tracks prompt caching performance across sessions and detects cache breaks.
 * Inspired by openclaw's prompt-cache-observability with simplifications.
 */

import { logger } from '../utils/logger.js'

/**
 * Normalized usage metrics from LLM providers
 */
export interface NormalizedUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

/**
 * Reasons for cache break detected
 */
export type CacheBreakReason =
  | 'model_change'
  | 'system_prompt_change'
  | 'tool_change'
  | 'provider_change'
  | 'first_request'
  | 'cache_retention_change'
  | 'unknown'

/**
 * Single cache observation record
 */
export interface CacheObservation {
  sessionId: string
  timestamp: number
  previousCacheRead: number
  currentCacheRead: number
  cacheHitRate: number
  totalPromptTokens: number
  cacheBreak?: {
    reason: CacheBreakReason
    tokenDrop: number
    details: string
  }
}

/**
 * Session cache statistics
 */
export interface SessionCacheStats {
  sessionId: string
  observationCount: number
  avgHitRate: number
  minHitRate: number
  maxHitRate: number
  totalCacheRead: number
  totalCacheWrite: number
  totalInput: number
  cacheBreaks: number
}

/**
 * Snapshot of cache-relevant session state
 */
interface CacheSnapshot {
  model: string
  provider: string
  systemPromptDigest: string
  toolNames: string
  cacheRetention: string
}

/**
 * In-memory tracker for a single session
 */
interface SessionTracker {
  snapshot: CacheSnapshot
  lastCacheRead: number
  observations: CacheObservation[]
}

/**
 * Configuration for cache monitoring
 */
export interface CacheMonitorConfig {
  /** Max trackers to keep in memory (LRU eviction) */
  maxTrackers: number
  /** Token drop threshold to consider a cache break */
  minTokenDrop: number
  /** Hit rate ratio threshold below which a drop is significant */
  stableRatioThreshold: number
  /** Minimum hit rate to warn about */
  warnThreshold: number
}

const DEFAULT_CONFIG: CacheMonitorConfig = {
  maxTrackers: 512,
  minTokenDrop: 1000,
  stableRatioThreshold: 0.9,
  warnThreshold: 0.7,
}

/**
 * Monitor cache hit rates and detect cache breaks.
 */
export class CacheMonitor {
  private trackers: Map<string, SessionTracker> = new Map()
  private config: CacheMonitorConfig

  constructor(config: Partial<CacheMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a cache observation from usage data.
   *
   * @param sessionId - Unique session identifier
   * @param usage - Normalized usage from LLM response
   * @param metadata - Current session metadata for change detection
   * @returns The observation record
   */
  observe(
    sessionId: string,
    usage: NormalizedUsage,
    metadata: {
      model: string
      provider: string
      systemPromptDigest: string
      toolNames: string[]
      cacheRetention?: string
    }
  ): CacheObservation {
    const currentCacheRead = usage.cacheRead ?? 0
    const currentCacheWrite = usage.cacheWrite ?? 0
    const input = usage.input ?? 0

    // Calculate total prompt tokens and hit rate
    const totalPromptTokens = input + currentCacheRead + currentCacheWrite
    const cacheHitRate = totalPromptTokens > 0 ? currentCacheRead / totalPromptTokens : 0

    // Get previous state
    const tracker = this.trackers.get(sessionId)
    const previousCacheRead = tracker?.lastCacheRead ?? 0

    // Build observation
    const observation: CacheObservation = {
      sessionId,
      timestamp: Date.now(),
      previousCacheRead,
      currentCacheRead,
      cacheHitRate,
      totalPromptTokens,
    }

    // Detect cache break
    if (previousCacheRead > 0) {
      const tokenDrop = previousCacheRead - currentCacheRead
      const ratio = currentCacheRead / previousCacheRead

      if (ratio < this.config.stableRatioThreshold && tokenDrop >= this.config.minTokenDrop) {
        const reason = this.detectCacheBreakReason(sessionId, metadata)
        observation.cacheBreak = {
          reason,
          tokenDrop,
          details: `Cache read dropped from ${previousCacheRead} to ${currentCacheRead} tokens (${(ratio * 100).toFixed(1)}%)`,
        }

        logger.warn(
          `[CacheMonitor] Cache break detected for session ${sessionId}: ${reason}. ${observation.cacheBreak.details}`
        )
      }
    }

    // Warn on low hit rate
    if (cacheHitRate < this.config.warnThreshold && totalPromptTokens > 5000) {
      logger.warn(
        `[CacheMonitor] Low cache hit rate for session ${sessionId}: ${(cacheHitRate * 100).toFixed(1)}% (${currentCacheRead}/${totalPromptTokens} tokens)`
      )
    }

    // Update tracker
    this.updateTracker(sessionId, observation, metadata)

    return observation
  }

  /**
   * Get statistics for a specific session.
   */
  getSessionStats(sessionId: string): SessionCacheStats | null {
    const tracker = this.trackers.get(sessionId)
    if (!tracker || tracker.observations.length === 0) {
      return null
    }

    const observations = tracker.observations
    const hitRates = observations.map((o) => o.cacheHitRate)

    return {
      sessionId,
      observationCount: observations.length,
      avgHitRate: hitRates.reduce((a, b) => a + b, 0) / hitRates.length,
      minHitRate: Math.min(...hitRates),
      maxHitRate: Math.max(...hitRates),
      totalCacheRead: observations.reduce((sum, o) => sum + o.currentCacheRead, 0),
      totalCacheWrite: 0, // Tracked separately if needed
      totalInput: observations.reduce((sum, o) => sum + o.totalPromptTokens, 0),
      cacheBreaks: observations.filter((o) => o.cacheBreak).length,
    }
  }

  /**
   * Get all session statistics.
   */
  getAllSessionStats(): SessionCacheStats[] {
    const stats: SessionCacheStats[] = []
    for (const sessionId of this.trackers.keys()) {
      const s = this.getSessionStats(sessionId)
      if (s) stats.push(s)
    }
    return stats
  }

  /**
   * Reset all trackers (useful for testing).
   */
  reset(): void {
    this.trackers.clear()
  }

  /**
   * Detect why cache broke by comparing metadata snapshots.
   */
  private detectCacheBreakReason(
    sessionId: string,
    current: {
      model: string
      provider: string
      systemPromptDigest: string
      toolNames: string[]
      cacheRetention?: string
    }
  ): CacheBreakReason {
    const previous = this.trackers.get(sessionId)?.snapshot
    if (!previous) {
      return 'first_request'
    }

    if (previous.model !== current.model) return 'model_change'
    if (previous.provider !== current.provider) return 'provider_change'
    if (previous.systemPromptDigest !== current.systemPromptDigest) return 'system_prompt_change'

    const prevTools = previous.toolNames
    const currTools = current.toolNames.sort().join(',')
    if (prevTools !== currTools) return 'tool_change'

    if (previous.cacheRetention !== (current.cacheRetention ?? 'short')) {
      return 'cache_retention_change'
    }

    return 'unknown'
  }

  /**
   * Update or create tracker for a session.
   */
  private updateTracker(
    sessionId: string,
    observation: CacheObservation,
    metadata: {
      model: string
      provider: string
      systemPromptDigest: string
      toolNames: string[]
      cacheRetention?: string
    }
  ): void {
    // Evict oldest if at capacity
    if (this.trackers.size >= this.config.maxTrackers && !this.trackers.has(sessionId)) {
      const oldestKey = this.trackers.keys().next().value
      if (typeof oldestKey === 'string') {
        this.trackers.delete(oldestKey)
      }
    }

    const existing = this.trackers.get(sessionId)
    const snapshot: CacheSnapshot = {
      model: metadata.model,
      provider: metadata.provider,
      systemPromptDigest: metadata.systemPromptDigest,
      toolNames: metadata.toolNames.sort().join(','),
      cacheRetention: metadata.cacheRetention ?? 'short',
    }

    if (existing) {
      existing.snapshot = snapshot
      existing.lastCacheRead = observation.currentCacheRead
      existing.observations.push(observation)
    } else {
      this.trackers.set(sessionId, {
        snapshot,
        lastCacheRead: observation.currentCacheRead,
        observations: [observation],
      })
    }
  }
}

/**
 * Create a global cache monitor instance.
 */
let globalMonitor: CacheMonitor | null = null

export function getGlobalCacheMonitor(config?: Partial<CacheMonitorConfig>): CacheMonitor {
  if (!globalMonitor) {
    globalMonitor = new CacheMonitor(config)
  }
  return globalMonitor
}

export function resetGlobalCacheMonitor(): void {
  globalMonitor = null
}
