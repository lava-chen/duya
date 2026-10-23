/**
 * PromptsRegistry - Registry for PromptSystem configs.
 *
 * Previous design: registered factories, cached instances per (name, profileKey).
 * Current design:  register configs, create instances on demand, cached per
 *                  (name, profileKey).
 *
 * Instance caching was removed at one point because only 4 promptSystems are
 * used in the main flow and the profileKey serialization looked like
 * needless complexity. It came back with plan 619 Phase 2, because the
 * instance owns the section cache: without a shared instance every build
 * started with an empty cache and `cachePolicy: 'once'` never actually
 * cached anything. The profile key is now a plain stable serialization of
 * the two lists a profile carries.
 *
 * The cache key of a section ALSO carries a fingerprint of the context it
 * was rendered against (see `contextFingerprint.ts`), so a shared instance
 * cannot serve stale bytes when the tool set or the model changes.
 *
 * Overlay patches (for @duya/conductor runtime registration) are kept —
 * the modes/ layer is flat now, but subsystems may still want to register
 * section-level patches. Currently no subsystem uses this; the API is
 * retained for backward compat.
 */

import type { PromptProfile } from './modes/types.js'
import type { PromptSystemConfig } from './PromptSystem.js'
import { PromptSystem } from './PromptSystem.js'
import { DEFAULT_PROMPT_PROFILE } from './modes/index.js'
import { promptProfileKey } from './modes/index.js'

/**
 * Registry for managing PromptSystem configs.
 */
export class PromptsRegistry {
  private static configs = new Map<string, PromptSystemConfig>()
  /** One live instance per (config name, profile key). */
  private static instances = new Map<string, PromptSystem>()

  /**
   * Register a prompt system config.
   */
  static register(name: string, config: PromptSystemConfig): void {
    this.configs.set(name, config)
    // A new config invalidates the instances built from the old one.
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}#`)) this.instances.delete(key)
    }
  }

  /**
   * Check if a system is registered.
   */
  static has(name: string): boolean {
    return this.configs.has(name)
  }

  /**
   * Get or create a system instance for the given name and profile.
   *
   * The instance is shared per (name, profile key): it owns the section
   * cache, and a fresh instance would start with an empty cache — which
   * is how `cachePolicy: 'once'` came to mean nothing.
   */
  static getOrCreate(name: string, profile?: PromptProfile): PromptSystem | undefined {
    const config = this.configs.get(name)
    if (!config) return undefined
    const resolved = profile ?? DEFAULT_PROMPT_PROFILE
    const key = `${name}#${promptProfileKey(resolved)}`
    const existing = this.instances.get(key)
    if (existing) return existing
    const created = new PromptSystem(config, resolved)
    this.instances.set(key, created)
    return created
  }

  /**
   * Get a system instance for the given name, using the default profile.
   */
  static get(name: string): PromptSystem | undefined {
    return this.getOrCreate(name, DEFAULT_PROMPT_PROFILE)
  }

  /**
   * Create a new system instance (alias for getOrCreate — kept for backward compat).
   */
  static create(name: string, profile?: PromptProfile): PromptSystem | undefined {
    return this.getOrCreate(name, profile)
  }

  /**
   * Get the raw config for a system (useful for inspection/testing).
   */
  static getConfig(name: string): PromptSystemConfig | undefined {
    return this.configs.get(name)
  }

  /**
   * Reset all registered configs.
   */
  static reset(): void {
    this.configs.clear()
    this.instances.clear()
  }

  /**
   * Get all registered system names.
   */
  static getRegisteredNames(): string[] {
    return Array.from(this.configs.keys())
  }

  /**
   * Unregister a system.
   */
  static unregister(name: string): boolean {
    return this.configs.delete(name)
  }

  // ---------------------------------------------------------------
  // Overlay patches — retained for backward compat.
  // Currently unused (modes/ is flat now), but @duya/conductor may
  // still reference the API. Safe to remove once confirmed unused.
  // ---------------------------------------------------------------

  private static overlayPatches = new Map<string, { enable?: string[]; disable?: string[] }>()

  /** @deprecated modes/ is flat now; overlay patches are no longer used. */
  static registerOverlayPatch(name: string, patch: { enable?: string[]; disable?: string[] }): void {
    this.overlayPatches.set(name, patch)
  }

  /** @deprecated modes/ is flat now; overlay patches are no longer used. */
  static getOverlayPatch(name: string): { enable?: string[]; disable?: string[] } | undefined {
    return this.overlayPatches.get(name)
  }

  /** @deprecated */
  static getRegisteredOverlayPatchNames(): string[] {
    return Array.from(this.overlayPatches.keys())
  }
}
