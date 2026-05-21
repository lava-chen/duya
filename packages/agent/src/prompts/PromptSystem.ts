/**
 * PromptSystem - Abstract Base Class
 * Provides the foundation for building agent-specific prompt systems
 */

import type {
  PromptContext,
  PromptSection,
  SystemPrompt,
  ToolPromptContribution,
  PromptBuildContextOptions,
} from './types.js'
import {
  asSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from './types.js'
import { PromptCache, createPromptCache } from './cache.js'
import type { PromptProfile } from './modes/types.js'
import { DEFAULT_PROMPT_PROFILE } from './modes/index.js'

/**
 * Factory interface for creating PromptSystem instances
 */
export interface PromptSystemFactory {
  create(profile?: PromptProfile): PromptSystem
}

/**
 * Abstract base class for prompt systems.
 * Each agent type has its own PromptSystem subclass with custom sections.
 */
export abstract class PromptSystem {
  protected cache: PromptCache
  protected profile: PromptProfile

  constructor(profile?: PromptProfile) {
    this.cache = createPromptCache()
    this.profile = profile ?? DEFAULT_PROMPT_PROFILE
  }

  /** Returns the system name (e.g., 'code', 'general', 'conductor') */
  abstract getName(): string

  /** Build the prompt context from options */
  abstract buildContext(options: PromptBuildContextOptions): PromptContext

  /** Build the complete system prompt from all sections */
  abstract buildSystemPrompt(
    context: PromptContext,
    enabledTools?: Set<string>,
    mcpServers?: PromptContext['mcpServers'],
  ): Promise<SystemPrompt>

  /** Get static sections (cached across turns) */
  abstract getStaticSections(
    context: PromptContext,
    enabledTools?: Set<string>,
    mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[]

  /** Get dynamic sections (recomputed every turn) */
  abstract getDynamicSections(
    context: PromptContext,
    enabledTools?: Set<string>,
    mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[]

  /** Clear the prompt cache */
  clearCache(): void {
    this.cache.clear()
  }

  /** Get the cache instance */
  getCache(): PromptCache {
    return this.cache
  }

  /** Get the current profile */
  getProfile(): PromptProfile {
    return { ...this.profile }
  }

  /** Update profile (clears cache) */
  setProfile(profile: PromptProfile): void {
    this.profile = profile
    this.clearCache()
  }

  /**
   * Template method: Resolve static and dynamic sections.
   * Static sections use cache, dynamic sections always recompute.
   */
  protected async resolveSections(
    staticSections: PromptSection[],
    dynamicSections: PromptSection[],
  ): Promise<{ staticContent: string[]; dynamicContent: string[] }> {
    // Resolve static sections (cached)
    const staticContent: string[] = []
    for (const section of staticSections) {
      const cached = this.cache.get(section.name)
      if (cached !== undefined) {
        if (cached !== null) {
          staticContent.push(cached)
        }
      } else {
        const content = await Promise.resolve(section.compute())
        this.cache.set(section.name, content)
        if (content !== null) {
          staticContent.push(content)
        }
      }
    }

    // Resolve dynamic sections (always recompute)
    const dynamicContent: string[] = []
    for (const section of dynamicSections) {
      const content = await Promise.resolve(section.compute())
      if (content !== null) {
        dynamicContent.push(content)
      }
    }

    return { staticContent, dynamicContent }
  }

  /**
   * Combine resolved sections into final system prompt.
   * Static content + dynamic boundary + dynamic content.
   */
  protected combineSections(
    staticContent: string[],
    dynamicContent: string[],
  ): SystemPrompt {
    return asSystemPrompt([
      ...staticContent,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicContent,
    ])
  }

  /**
   * Get tool prompt contributions.
   * Override in subclass for custom tools.
   */
  protected getToolContributions(): ToolPromptContribution[] {
    return []
  }
}