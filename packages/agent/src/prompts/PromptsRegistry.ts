/**
 * PromptsRegistry - Registry for PromptSystem instances
 * Manages registration and retrieval of prompt systems by name
 */

import type { PromptProfile } from './modes/types.js'
import type { PromptSystem } from './PromptSystem.js'

/**
 * Factory interface for creating prompt system instances.
 */
export interface PromptSystemFactory {
  create(profile?: PromptProfile): PromptSystem
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
   * Get a system instance (singleton per name).
   * Creates instance on first call, returns cached instance thereafter.
   */
  static get(name: string, profile?: PromptProfile): PromptSystem | undefined {
    if (!this.instances.has(name)) {
      const factory = this.systems.get(name)
      if (factory) {
        this.instances.set(name, factory.create(profile))
      }
    }
    return this.instances.get(name)
  }

  /**
   * Create a new system instance (non-singleton).
   * Always creates a fresh instance.
   */
  static create(name: string, profile?: PromptProfile): PromptSystem | undefined {
    const factory = this.systems.get(name)
    return factory?.create(profile)
  }

  /**
   * Reset all cached instances.
   * Call when configuration changes.
   */
  static reset(): void {
    this.instances.clear()
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
    this.instances.delete(name)
    return this.systems.delete(name)
  }
}