/**
 * PromptSystem - Single concrete class (config-driven, no subclasses).
 *
 * Previous design: abstract base class + 4 subclasses (General/Code/Research/
 *                  Gateway), each ~150-370 lines of boilerplate.
 * Current design:  one PromptSystem class + declarative PromptSystemConfig.
 *
 * A PromptSystemConfig declares:
 *   - name: identifier ('general' / 'code' / 'research' / 'gateway')
 *   - staticSections: cached across buildSystemPrompt calls
 *   - dynamicSections: recomputed on every buildSystemPrompt call
 *     (note: buildSystemPrompt is called once per streamChat, not per turn;
 *     mid-stream skill load/unload will not refresh the catalog until the
 *     next streamChat — see DuyaAgent.streamChat turn loop)
 *   - optional hooks:
 *     - contextExtender: inject extra fields into PromptContext (e.g. research fields)
 *     - preBuildHook: async side-effect before buildSystemPrompt (e.g. initializeAgentsMd)
 *     - extraPromptGenerators: parallel prompt methods
 *
 * Sections support `bypassProfile: true` to skip isSectionEnabled filtering
 * (used by research for sections that must always appear).
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
import { DEFAULT_PROMPT_PROFILE, isSectionEnabled } from './modes/index.js'
import { cachedPromptSection, volatilePromptSection } from './constants/promptSections.js'
import { getShellForPrompt } from '../utils/shellDetector.js'

/**
 * A section definition in a PromptSystemConfig.
 */
export interface SectionDef {
  /** Unique section name within this PromptSystem. */
  name: string
  /** Compute the section content. Return null to omit. */
  compute: (context: PromptContext) => string | null | Promise<string | null>
  /**
   * If true, skip isSectionEnabled filtering — this section always renders.
   * Used by research for sections that exist outside the generic
   * profile gating (e.g. researchProfile, evidencePolicy).
   */
  bypassProfile?: boolean
  /** Optional description for debugging. */
  description?: string
}

/**
 * Hook: extend the base PromptContext with extra fields.
 * Used by research (researchIntent/researchProjectId).
 */
export type ContextExtender = (
  base: PromptContext,
  options: PromptBuildContextOptions,
) => Partial<PromptContext>

/**
 * Hook: async side-effect before buildSystemPrompt resolves sections.
 * Returns cache keys to invalidate. Used by general/code/research to
 * call initializeAgentsMd and invalidate the project/agentsMd cache entry.
 */
export type PreBuildHook = (
  context: PromptContext,
) => Promise<{ invalidateCacheKeys?: string[] } | void>

/**
 * Hook: parallel prompt generators that don't go through buildSystemPrompt.
 */
export type ExtraPromptGenerators = Record<string, (...args: unknown[]) => string>

/**
 * Declarative configuration for a PromptSystem.
 */
export interface PromptSystemConfig {
  /** System name ('general' / 'code' / 'research' / 'gateway'). */
  name: string
  /** Static (cached) sections. */
  staticSections: SectionDef[]
  /** Dynamic (volatile) sections. */
  dynamicSections: SectionDef[]
  /** Optional: extend PromptContext with extra fields after base mapping. */
  contextExtender?: ContextExtender
  /** Optional: async side-effect before buildSystemPrompt. */
  preBuildHook?: PreBuildHook
  /** Optional: parallel prompt generators (not part of buildSystemPrompt). */
  extraPromptGenerators?: ExtraPromptGenerators
}

/**
 * Single concrete PromptSystem class. Replaces the previous abstract base
 * + 5 subclasses. Behavior is fully driven by the PromptSystemConfig passed
 * to the constructor.
 */
export class PromptSystem {
  private readonly config: PromptSystemConfig
  private cache: PromptCache
  private profile: PromptProfile

  constructor(config: PromptSystemConfig, profile?: PromptProfile) {
    this.config = config
    this.cache = createPromptCache()
    this.profile = profile ?? DEFAULT_PROMPT_PROFILE
  }

  /** Returns the system name (e.g., 'general', 'code'). */
  getName(): string {
    return this.config.name
  }

  /** Clear the prompt cache. */
  clearCache(): void {
    this.cache.clear()
  }

  /** Get the cache instance. */
  getCache(): PromptCache {
    return this.cache
  }

  /** Get the current profile. */
  getProfile(): PromptProfile {
    return { ...this.profile }
  }

  /** Update profile (clears cache). */
  setProfile(profile: PromptProfile): void {
    this.profile = profile
    this.clearCache()
  }

  /** Access extra prompt generators. */
  getExtraPromptGenerator(name: string): ((...args: unknown[]) => string) | undefined {
    return this.config.extraPromptGenerators?.[name]
  }

  /**
   * Build the prompt context from options.
   * Base mapping + optional contextExtender hook.
   */
  buildContext(options: PromptBuildContextOptions): PromptContext {
    const workingDirectory = options.workingDirectory !== undefined && options.workingDirectory !== null
      ? options.workingDirectory
      : process.cwd()

    const base: PromptContext = {
      sessionId: options.sessionId,
      workingDirectory,
      additionalWorkingDirectories: options.additionalWorkingDirectories,
      platform: process.platform,
      shell: getShellForPrompt(),
      modelId: options.modelId || 'unknown-model',
      modelName: options.modelName,
      enabledTools: options.enabledTools || new Set(),
      mcpServers: options.mcpServers,
      sessionStartTime: Date.now(),
      language: options.language,
      userType: options.userType,
      outputStyleConfig: options.outputStyleConfig,
      communicationPlatform: options.communicationPlatform,
      isWorktree: options.isWorktree,
      isNonInteractiveSession: options.isNonInteractiveSession,
      isReplModeEnabled: options.isReplModeEnabled,
      hasEmbeddedSearchTools: options.hasEmbeddedSearchTools,
      isForkSubagentEnabled: options.isForkSubagentEnabled,
      isVerificationAgentEnabled: options.isVerificationAgentEnabled,
      isSkillSearchEnabled: options.isSkillSearchEnabled,
      scratchpadDir: options.scratchpadDir,
      researchIntent: options.researchIntent,
      researchProjectId: options.researchProjectId,
    }

    if (this.config.contextExtender) {
      return { ...base, ...this.config.contextExtender(base, options) }
    }
    return base
  }

  /**
   * Get static sections (cached across turns).
   * Filters by isSectionEnabled unless section declares bypassProfile.
   */
  getStaticSections(context: PromptContext): PromptSection[] {
    const sections: PromptSection[] = []
    for (const def of this.config.staticSections) {
      if (!def.bypassProfile && !isSectionEnabled(this.profile, def.name)) continue
      sections.push(cachedPromptSection(def.name, () => def.compute(context)))
    }
    return sections
  }

  /**
   * Get dynamic sections (recomputed every turn).
   * Filters by isSectionEnabled unless section declares bypassProfile.
   */
  getDynamicSections(context: PromptContext): PromptSection[] {
    const sections: PromptSection[] = []
    for (const def of this.config.dynamicSections) {
      if (!def.bypassProfile && !isSectionEnabled(this.profile, def.name)) continue
      sections.push(
        volatilePromptSection(def.name, () => def.compute(context), def.description ?? 'Dynamic section'),
      )
    }
    return sections
  }

  /**
   * Build the complete system prompt.
   * Template method: preBuildHook → getSections → resolve → combine.
   */
  async buildSystemPrompt(context: PromptContext): Promise<SystemPrompt> {
    // Pre-build hook: async side-effects + cache invalidation.
    if (this.config.preBuildHook) {
      const result = await this.config.preBuildHook(context)
      if (result?.invalidateCacheKeys) {
        for (const key of result.invalidateCacheKeys) {
          this.cache.delete(key)
        }
      }
    }

    const staticSections = this.getStaticSections(context)
    const dynamicSections = this.getDynamicSections(context)

    const { staticContent, dynamicContent } = await this.resolveSections(
      staticSections,
      dynamicSections,
    )

    return asSystemPrompt([
      ...staticContent,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicContent,
    ])
  }

  /**
   * Resolve static and dynamic sections.
   * Static: consult cache, populate on miss.
   * Dynamic: always recompute.
   */
  private async resolveSections(
    staticSections: PromptSection[],
    dynamicSections: PromptSection[],
  ): Promise<{ staticContent: string[]; dynamicContent: string[] }> {
    // Static: consult cache first (in order), collect misses, then compute misses in parallel.
    const staticSlots: (string | null)[] = new Array(staticSections.length).fill(null)
    const missIndices: number[] = []
    const missSections: PromptSection[] = []
    staticSections.forEach((section, i) => {
      const cached = this.cache.get(section.name)
      if (cached !== undefined) {
        if (cached !== null) {
          staticSlots[i] = cached
        }
      } else {
        missIndices.push(i)
        missSections.push(section)
      }
    })

    if (missSections.length > 0) {
      const missResults = await Promise.all(
        missSections.map(section => Promise.resolve(section.compute())),
      )
      missResults.forEach((content, idx) => {
        const section = missSections[idx]
        const originalIdx = missIndices[idx]
        this.cache.set(section.name, content)
        if (content !== null) {
          staticSlots[originalIdx] = content
        }
      })
    }

    const staticContent = staticSlots.filter(
      (c): c is string => c !== null,
    )

    // Dynamic: always recompute, run in parallel, preserve original order.
    const dynamicResults = await Promise.all(
      dynamicSections.map(section => Promise.resolve(section.compute())),
    )
    const dynamicContent: string[] = []
    for (const content of dynamicResults) {
      if (content !== null) {
        dynamicContent.push(content)
      }
    }

    return { staticContent, dynamicContent }
  }

  /**
   * Backward-compat: previously a protected method on the abstract base.
   * Some callers may still reference it — return empty array (no tool
   * contributions in the new config-driven model; tool guidance is baked
   * into the tools section's compute function directly).
   */
  protected getToolContributions(): ToolPromptContribution[] {
    return []
  }
}

/**
 * Factory interface for creating PromptSystem instances.
 * Kept for PromptsRegistry compatibility.
 */
export interface PromptSystemFactory {
  create(profile?: PromptProfile): PromptSystem
}
