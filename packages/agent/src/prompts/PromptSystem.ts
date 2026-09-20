/**
 * PromptSystem - Single concrete class (config-driven, no subclasses).
 *
 * Previous design: abstract base class + 4 subclasses (General/Code/Research/
 *                  Gateway), each ~150-370 lines of boilerplate.
 * Current design:  one PromptSystem class + declarative PromptSystemConfig.
 *
 * A PromptSystemConfig declares:
 *   - name: identifier ('general' / 'code' / 'research' / 'gateway')
 *   - staticModules: registry-assembled static half, cached across
 *     buildSystemPrompt calls (Plan 551)
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
import { HbsPromptSystem } from './hbs/HbsPromptSystem.js'
import { MODULES } from './modules/registry.js'
import type { StaticModuleRef, ModuleName } from './modules/registry.js'

/**
 * Process-wide HbsPromptSystem singleton. Plan 550: keeping a single
 * instance lets every PromptSystem share the compile cache, so the
 * first-turn cost of `Handlebars.compile` is amortised across the whole
 * agent lifetime. Construction is lazy so test code can mock the assets
 * root via `HbsPromptSystem` directly.
 */
let sharedHbsPromptSystem: HbsPromptSystem | undefined
function getSharedHbsPromptSystem(): HbsPromptSystem {
  if (!sharedHbsPromptSystem) {
    sharedHbsPromptSystem = new HbsPromptSystem()
  }
  return sharedHbsPromptSystem
}

/**
 * Render a single section through either its .hbs template (Plan 550 1c)
 * or its TS `compute` function. The template path takes priority when
 * both are present so a config can declare a .hbs override while keeping
 * the TS function around for unit tests.
 */
async function renderSectionCompute(
  def: SectionDef,
  context: PromptContext,
): Promise<string | null> {
  if (def.template) {
    const hbsSystem = getSharedHbsPromptSystem()
    const out = hbsSystem.renderStaticTemplate(def.template, context, def.params).trim()
    return out === '' ? null : out
  }
  // Plan 550 1d-delete: `compute` is optional when `template` is set, so
  // sections that have migrated exclusively to .hbs don't need a stub.
  // When only `compute` is present, fall through to the legacy path.
  if (!def.compute) {
    throw new Error(
      `PromptSystem section '${def.name}' has neither 'template' nor 'compute' — at least one is required.`,
    )
  }
  return await Promise.resolve(def.compute(context))
}

/**
 * Cache policy for a prompt section.
 *
 * - `'once'`: compute once and cache for the lifetime of the PromptSystem
 *            instance (within a streamChat call). Corresponds to the legacy
 *            "static" semantics.
 * - `'every-call'`: recompute on every buildSystemPrompt call. Corresponds
 *                   to the legacy "dynamic" semantics.
 */
export type SectionCachePolicy = 'once' | 'every-call'

/**
 * A section definition in a PromptSystemConfig.
 */
export interface SectionDef {
  /** Unique section name within this PromptSystem. Defaults to `module` when a registry ref is given. */
  name?: string
  /**
   * Registry module to render for this section. When set, the section
   * content is produced by HbsPromptSystem.renderModule(module, ctx, params).
   * The `enabledWhen` gate (if present) is evaluated before rendering.
   * Cannot be combined with `compute` or `template`.
   */
  module?: ModuleName
  /**
   * Compute the section content. Return null to omit.
   *
   * Plan 550 1d-delete: optional when `template` is set — a section can
   * render exclusively through its `.hbs` template without keeping the
   * legacy TS function around. When both are present, the template path
   * takes priority (see `renderSectionCompute` below) so `compute` is
   * only used as a fallback when the `.hbs` is missing.
   */
  compute?: (context: PromptContext) => string | null | Promise<string | null>
  /**
   * Optional: when set, render the section via the HbsPromptSystem instead
   * of calling `compute`. Plan 550 1c uses this to migrate individual
   * dynamic sections to .hbs without forcing the whole config over. The
   * template receives the same `mapPromptContextToHbs` context as the
   * static-template path; `compute` is kept as a reference but never
   * invoked when `template` is present.
   */
  template?: string
  /**
   * Optional: extra template variables merged over the base mapper output
   * when the section renders via `template` (Plan 551). Assembly-time
   * variant flags a config passes per module reference, e.g.
   * `{ variant: 'compact' }`. Ignored on the `compute` path.
   */
  params?: Record<string, unknown>
  /**
   * Optional config-side content gate evaluated per render, before the
   * section renders. Returning false collapses the section to null (same
   * as a legacy `compute` returning null). Applied both to registry module
   * refs and inline section defs.
   */
  enabledWhen?: (context: PromptContext) => boolean
  /**
   * If true, skip isSectionEnabled filtering — this section always renders.
   * Used by research for sections that exist outside the generic
   * profile gating (e.g. researchProfile, evidencePolicy).
   */
  bypassProfile?: boolean
  /** Optional description for debugging. */
  description?: string
  /**
   * Cache policy for this section. Defaults to `'once'` for registry module
   * references and `'every-call'` for inline section definitions.
   *
   * `'once'`: cached across buildSystemPrompt calls within the same
   *           PromptSystem instance (same as legacy "static" semantics).
   * `'every-call'`: recomputed every buildSystemPrompt call (same as legacy
   *                 "dynamic" semantics).
   */
  cachePolicy?: SectionCachePolicy
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
 * Returns cache keys to invalidate and an optional context-extension
 * delta that gets merged into `PromptContext` before section rendering.
 *
 * Used by general/code/research to:
 *   - call `initializeAgentsMd` and invalidate the project/agentsMd cache entry
 *     (the `invalidateCacheKeys` half of the contract);
 *   - pre-compute Plan 550 1d-rest dynamic-section inputs (memory
 *     summary file, recent-session directory, environment git detection,
 *     skills registry snapshot) and inject them as `promptContextExtension`.
 *     The preBuildHook runs once per `buildSystemPrompt`; the section
 *     templates then read the injected fields synchronously.
 */
export type PreBuildHook = (
  context: PromptContext,
) => Promise<{
  invalidateCacheKeys?: string[];
  promptContextExtension?: Partial<PromptContext>;
} | void>

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
  /**
   * Unified section list. Each entry is either a registry-module reference
   * (with `module` key) or an inline section definition (with `compute` and/or
   * `template`). The `cachePolicy` field (defaults to `'once'` for registry
   * refs, `'every-call'` for inline defs) determines whether the section is
   * cached across buildSystemPrompt calls or recomputed every call.
   *
   * Previously split into `staticModules` (registry refs, cached) and
   * `dynamicSections` (inline defs, uncached). The distinction is now
   * expressed purely via `cachePolicy` on each entry.
   */
  sections: SectionDef[]
  /** @deprecated Use `sections` instead. Kept for incremental migration. */
  staticModules?: StaticModuleRef[]
  /** @deprecated Use `sections` instead. Kept for incremental migration. */
  dynamicSections?: SectionDef[]
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
      omitAgentsMd: options.omitAgentsMd,
      // Plan 525 / 408 follow-up: project-entity home directory. Forwarded
      // into the PromptContext so preBuildHook (initializeAgentsMd) can
      // read it and feed it into the agentsmd loader as the
      // `'Project entity'` source. Optional — caller may leave it absent.
      projectHome: options.projectHome,
    }

    if (this.config.contextExtender) {
      return { ...base, ...this.config.contextExtender(base, options) }
    }
    return base
  }

  /**
   * Get all sections (both cached and volatile) in render order.
   * Filters by isSectionEnabled unless section declares bypassProfile.
   *
   * Registry module references (def.module set) are resolved to their
   * .hbs render through the shared HbsPromptSystem. Inline sections
   * (def.compute / def.template) are rendered directly.
   *
   * The `cachePolicy` field on each section controls caching:
   *   'once'       → wrapped in cachedPromptSection (cached across calls)
   *   'every-call' → wrapped in volatilePromptSection (never cached)
   *
   * When `cachePolicy` is absent the default is 'once' for registry refs
   * and 'every-call' for inline defs.
   */
  getAllSections(context: PromptContext): PromptSection[] {
    const sections: PromptSection[] = []

    for (const def of this.config.sections) {
      const sectionName = def.name ?? def.module ?? 'anonymous'
      if (!def.bypassProfile && !isSectionEnabled(this.profile, sectionName)) continue

      const section = this.buildSectionFromDef(def, context)
      if (section) sections.push(section)
    }

    return sections
  }

  /**
   * Build a PromptSection from a SectionDef.
   * Registry module refs resolve via HbsPromptSystem; inline defs
   * resolve via renderSectionCompute.
   */
  private buildSectionFromDef(def: SectionDef, context: PromptContext): PromptSection | null {
    const cachePolicy = def.cachePolicy ?? (def.module ? 'once' : 'every-call')
    const sectionName = def.name ?? def.module ?? 'anonymous'
    const compute = () => {
      if (def.module) {
        // Registry module reference — resolve via the shared HbsPromptSystem.
        if (def.enabledWhen && !def.enabledWhen(context)) return null
        const out = getSharedHbsPromptSystem()
          .renderModule(def.module, context, def.params)
          .trim()
        return out === '' ? null : out
      }
      return renderSectionCompute(def, context)
    }

    if (cachePolicy === 'once') {
      return cachedPromptSection(sectionName, compute)
    } else {
      return volatilePromptSection(
        sectionName,
        compute,
        def.description ?? 'Dynamic section',
      )
    }
  }

  /**
   * Build the complete system prompt.
   * Template method: preBuildHook → getAllSections → resolve cached →
   * recompute volatile → combine.
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
      if (result?.promptContextExtension) {
        context = { ...context, ...result.promptContextExtension }
      }
    }

    const allSections = this.getAllSections(context)

    // Partition into cached ('once') and volatile ('every-call') sections.
    const cachedSections: PromptSection[] = []
    const volatileSections: PromptSection[] = []
    for (const section of allSections) {
      if (section.volatile) {
        volatileSections.push(section)
      } else {
        cachedSections.push(section)
      }
    }

    // Volatile sections: always recompute (parallel).
    const volatileResults = await Promise.all(
      volatileSections.map(section => Promise.resolve(section.compute())),
    )
    const volatileContent = volatileResults.filter(
      (c): c is string => c !== null,
    )

    // Cached sections: consult cache, populate on miss.
    const { staticContent } = await this.resolveSections(cachedSections)

    return asSystemPrompt([
      ...staticContent,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...volatileContent,
    ])
  }

  /**
   * Resolve cached sections: consult cache, populate on miss.
   * Volatile sections are handled separately in buildSystemPrompt.
   */
  private async resolveSections(
    cachedSections: PromptSection[],
  ): Promise<{ staticContent: string[] }> {
    const slots: (string | null)[] = new Array(cachedSections.length).fill(null)
    const missIndices: number[] = []
    const missSections: PromptSection[] = []
    cachedSections.forEach((section, i) => {
      const cached = this.cache.get(section.name)
      if (cached !== undefined) {
        if (cached !== null) {
          slots[i] = cached
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
          slots[originalIdx] = content
        }
      })
    }

    const staticContent = slots.filter((c): c is string => c !== null)
    return { staticContent }
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
