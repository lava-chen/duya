/**
 * Cache Configuration
 *
 * Centralized configuration for all caching layers.
 */

import type { CacheRetention } from '../llm/prompt-caching.js'
import type { CacheMonitorConfig } from '../observability/cache-monitor.js'

/**
 * Configuration for L1: Agent instance cache
 */
export interface AgentCacheConfig {
  /** Enable agent instance caching */
  enabled: boolean
  /** Maximum number of cached agent instances */
  maxSize: number
  /** Idle TTL in milliseconds before eviction */
  idleTtlMs: number
}

/**
 * Configuration for L2: Prompt section cache
 */
export interface SectionCacheConfig {
  /** Enable prompt section caching */
  enabled: boolean
  /** Maximum number of cached sections */
  maxSize: number
}

/**
 * Configuration for L3: LLM API prompt caching
 */
export interface PromptCacheConfig {
  /** Enable LLM API prompt caching */
  enabled: boolean
  /** Default cache retention policy */
  defaultRetention: CacheRetention
  /** Provider-specific overrides */
  providerOverrides: Record<string, {
    enabled: boolean
    retention: CacheRetention
  }>
}

/**
 * Complete cache configuration
 */
export interface CacheConfig {
  agent: AgentCacheConfig
  section: SectionCacheConfig
  prompt: PromptCacheConfig
  monitor: CacheMonitorConfig
}

/**
 * Default cache configuration
 */
export const defaultCacheConfig: CacheConfig = {
  agent: {
    enabled: true,
    maxSize: 128,
    idleTtlMs: 60 * 60 * 1000, // 1 hour
  },
  section: {
    enabled: true,
    maxSize: 50,
  },
  prompt: {
    enabled: true,
    defaultRetention: 'short',
    providerOverrides: {
      anthropic: { enabled: true, retention: 'long' },
      'anthropic-vertex': { enabled: true, retention: 'long' },
      openrouter: { enabled: true, retention: 'short' },
      google: { enabled: true, retention: 'short' },
      gemini: { enabled: true, retention: 'short' },
    },
  },
  monitor: {
    maxTrackers: 512,
    minTokenDrop: 1000,
    stableRatioThreshold: 0.9,
    warnThreshold: 0.7,
  },
}

/**
 * Resolve cache retention for a specific provider.
 */
export function resolveCacheRetention(
  provider: string,
  config: CacheConfig = defaultCacheConfig
): CacheRetention {
  const override = config.prompt.providerOverrides[provider.toLowerCase()]
  if (override?.enabled) {
    return override.retention
  }
  return config.prompt.defaultRetention
}

/**
 * Check if prompt caching is enabled for a provider.
 */
export function isPromptCachingEnabled(
  provider: string,
  config: CacheConfig = defaultCacheConfig
): boolean {
  if (!config.prompt.enabled) {
    return false
  }
  const override = config.prompt.providerOverrides[provider.toLowerCase()]
  return override?.enabled ?? true
}
