/**
 * PromptsRegistry - Registry for PromptSystem configs.
 *
 * Previous design: registered factories, cached instances per (name, profileKey).
 * Current design:  register configs, create instances on demand (no cache).
 *
 * Instance caching was removed because:
 * 1. Only 4 promptSystems are used in the main flow — cache hit rate was low.
 * 2. Profile changes now just create a new instance (cheap).
 * 3. The profileKey serialization was a non-trivial source of complexity.
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

/**
 * Registry for managing PromptSystem configs.
 */
export class PromptsRegistry {
  private static configs = new Map<string, PromptSystemConfig>()

  /**
   * Register a prompt system config.
   */
  static register(name: string, config: PromptSystemConfig): void {
    this.configs.set(name, config)
  }

  /**
   * Check if a system is registered.
   */
  static has(name: string): boolean {
    return this.configs.has(name)
  }

  /**
   * Get or create a system instance for the given name and profile.
   * Always creates a fresh instance — no caching. Profile is applied
   * via setProfile if provided.
   */
  static getOrCreate(name: string, profile?: PromptProfile): PromptSystem | undefined {
    const config = this.configs.get(name)
    if (!config) return undefined
    return new PromptSystem(config, profile ?? DEFAULT_PROMPT_PROFILE)
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
