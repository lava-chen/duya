/**
 * PromptsRegistry - Registry for PromptSystem instances
 * Manages registration and retrieval of prompt systems by name.
 *
 * Instance caching is keyed by (name, profile) — different profiles get
 * different instances so that per-profile section filtering takes effect.
 *
 * Use `get(name)` for the legacy/default profile path; use `getOrCreate(name, profile)`
 * when the caller has a specific profile to apply.
 */

import type { PromptProfile } from './modes/types.js'
import type { PromptSystem } from './PromptSystem.js'
import { DEFAULT_PROMPT_PROFILE } from './modes/index.js'

/**
 * Factory interface for creating prompt system instances.
 */
export interface PromptSystemFactory {
  create(profile?: PromptProfile): PromptSystem
}

/**
 * Stable serialization of a PromptProfile for use as a cache key.
 * Order-independent: `{ a: [1] }` and `{ a: [1] }` produce the same key regardless of object key order.
 */
export function profileKey(profile: PromptProfile): string {
  const overlays = (profile.overlays ?? []).slice().sort().join(',')
  const enable = (profile.overrides?.enableSections ?? []).slice().sort().join(',')
  const disable = (profile.overrides?.disableSections ?? []).slice().sort().join(',')
  return `${profile.base}|o:${overlays}|+:${enable}|-:${disable}`
}

/**
 * Registry for managing PromptSystem instances and factories.
 */
export class PromptsRegistry {
  private static systems = new Map<string, PromptSystemFactory>()
  private static instances = new Map<string, PromptSystem>()

  /**
   * Register a prompt system factory.
   */
  static register(name: string, factory: PromptSystemFactory): void {
    this.systems.set(name, factory)
  }

  /**
   * Check if a system is registered.
   */
  static has(name: string): boolean {
    return this.systems.has(name)
  }

  /**
   * Get a system instance for the given name, using the default profile.
   *
   * Prefer `getOrCreate(name, profile)` when the caller has a specific profile.
   * This overload exists for backward compatibility — its returned instance is
   * cached under (name, DEFAULT_PROMPT_PROFILE).
   */
  static get(name: string): PromptSystem | undefined {
    return this.getOrCreate(name, DEFAULT_PROMPT_PROFILE)
  }

  /**
   * Get or create a system instance for the given name and profile.
   * Instances are cached per (name, profile) pair — different profiles yield
   * different instances. Same (name, profile) returns the same instance.
   */
  static getOrCreate(name: string, profile: PromptProfile): PromptSystem | undefined {
    const key = `${name}::${profileKey(profile)}`
    const existing = this.instances.get(key)
    if (existing) {
      return existing
    }
    const factory = this.systems.get(name)
    if (!factory) {
      return undefined
    }
    const instance = factory.create(profile)
    this.instances.set(key, instance)
    return instance
  }

  /**
   * Create a new system instance (non-singleton) for the given name and profile.
   * Always returns a fresh instance — does not consult or update the cache.
   */
  static create(name: string, profile?: PromptProfile): PromptSystem | undefined {
    const factory = this.systems.get(name)
    return factory?.create(profile)
  }

  /**
   * Reset cached instances.
   * If `name` is provided, only instances for that name (across all profiles) are dropped.
   * If omitted, all instances are dropped.
   */
  static reset(name?: string): void {
    if (!name) {
      this.instances.clear()
      return
    }
    const prefix = `${name}::`
    for (const key of Array.from(this.instances.keys())) {
      if (key.startsWith(prefix)) {
        this.instances.delete(key)
      }
    }
  }

  /**
   * Get all registered system names.
   */
  static getRegisteredNames(): string[] {
    return Array.from(this.systems.keys())
  }

  /**
   * Unregister a system.
   */
  static unregister(name: string): boolean {
    const prefix = `${name}::`
    for (const key of Array.from(this.instances.keys())) {
      if (key.startsWith(prefix)) {
        this.instances.delete(key)
      }
    }
    return this.systems.delete(name)
  }
}