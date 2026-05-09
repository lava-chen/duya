/**
 * Prompt Manager - Central orchestrator for prompt engineering
 * Handles section resolution, caching, and system prompt building
 */

import type {
  PromptContext,
  PromptManagerOptions,
  PromptSection,
  SystemPrompt,
  ToolPromptContribution,
  OutputStyleConfig,
  CommunicationPlatform,
} from './types.js'
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './types.js'
import { PromptCache, createPromptCache } from './cache.js'
import {
  cachedPromptSection,
  volatilePromptSection,
} from './constants/promptSections.js'
import {
  resolveEnabledSections,
  isSectionEnabled,
  DEFAULT_PROMPT_PROFILE,
} from './modes/index.js'
import type { PromptProfile } from './modes/types.js'

// ============================================================
// Section Imports
// ============================================================

import { getIntroSection } from './sections/intro.js'
import { getSystemSection } from './sections/system.js'
import { getTaskHandlingSection } from './sections/taskHandling.js'
import { getActionsSection } from './sections/actions.js'
import { getToolUsageSection } from './sections/toolUsage.js'
import { getToneAndStyleSection } from './sections/toneAndStyle.js'
import { getOutputEfficiencySection } from './sections/outputEfficiency.js'
import { getEnvironmentSection } from './sections/dynamic/environment.js'
import { getPlatformSection } from './sections/dynamic/platform.js'
import { getMcpInstructionsSection } from './sections/dynamic/mcpInstructions.js'
import { getSessionGuidanceSection } from './sections/dynamic/sessionGuidance.js'
import { getSkillsMetadataSection } from './sections/dynamic/skillsMetadata.js'
import { getLanguageSection } from './sections/dynamic/language.js'
import { getScratchpadSection } from './sections/dynamic/scratchpad.js'
import { getOutputStyleSection } from './sections/dynamic/outputStyle.js'
import { getSessionSearchSection } from './sections/dynamic/sessionSearchSection.js'
import { getMemorySection } from './sections/dynamic/memorySection.js'
import { getWidgetGuidelinesSection } from './sections/dynamic/widgetGuidelines.js'
import { getConductorCanvasSection } from './sections/dynamic/conductorCanvas.js'
import { getMemoryManager } from '../memory/index.js'
import { getShellForPrompt } from '../utils/shellDetector.js'
import {
  initializeAgentsMd,
} from './sections/dynamic/agentsMdSection.js'
import { getAgentsMdManager } from '../agentsmd/index.js'

// ============================================================
// Prompt Manager
// ============================================================

export class PromptManager {
  private cache: PromptCache
  private options: PromptManagerOptions
  private profile: PromptProfile

  constructor(options: PromptManagerOptions = {}) {
    this.cache = createPromptCache()
    this.options = options
    this.profile = options.promptProfile ?? DEFAULT_PROMPT_PROFILE
  }

  /**
   * Update the working directory
   */
  setWorkingDirectory(directory: string): void {
    this.options.workingDirectory = directory
  }

  /**
   * Set the prompt profile.
   * Profile should be determined at agent creation time.
   * Changing profile clears the cache to avoid mixed behavior.
   */
  setPromptProfile(profile: PromptProfile): void {
    this.profile = profile
    this.clearCache()
  }

  /**
   * Get the current prompt profile
   */
  getPromptProfile(): PromptProfile {
    return { ...this.profile }
  }

  /**
   * Build the system prompt from all sections.
   * Sections are filtered based on the current prompt profile.
   */
  async buildSystemPrompt(
    enabledTools?: Set<string>,
    mcpServers?: PromptContext['mcpServers'],
  ): Promise<SystemPrompt> {
    const context = this.buildContext(enabledTools, mcpServers)

    const outputStyleConfig = this.options.outputStyleConfig ?? null
    const keepCodingInstructions = outputStyleConfig?.keepCodingInstructions !== false

    // Initialize AGENTS.md only when enabled for this profile
    if (isSectionEnabled(this.profile, 'agentsMd')) {
      await initializeAgentsMd(context.workingDirectory)
    }

    // Resolve enabled sections based on profile
    const enabledSectionNames = resolveEnabledSections(this.profile)

    // Helper to conditionally include a cached section
    const maybeCached = (name: string, compute: () => string | null | Promise<string | null>): PromptSection | null => {
      if (!enabledSectionNames.has(name)) return null
      return cachedPromptSection(name, compute)
    }

    // Helper to conditionally include a volatile section
    const maybeVolatile = (name: string, compute: () => string | null | Promise<string | null>, reason?: string): PromptSection | null => {
      if (!enabledSectionNames.has(name)) return null
      return volatilePromptSection(name, compute, reason)
    }

    // Define all static sections (filtered by profile)
    const staticSections: PromptSection[] = [
      maybeCached('intro', () => getIntroSection(context)),
      maybeCached('system', () => getSystemSection(context)),
      ...(keepCodingInstructions && enabledSectionNames.has('taskHandling')
        ? [cachedPromptSection('taskHandling', () => getTaskHandlingSection(context))]
        : []),
      maybeCached('actions', () => getActionsSection(context)),
      maybeCached('toolUsage', () => getToolUsageSection(context, this.getToolContributions())),
      maybeCached('toneAndStyle', () => getToneAndStyleSection(context)),
      maybeCached('outputEfficiency', () => getOutputEfficiencySection(context)),
      // AGENTS.md: project and user instructions (frozen at session start)
      maybeCached('agentsMd', () => getAgentsMdManager().buildAgentsMdPrompt()),
      // Memory: guidance + actual memory content (frozen at session start)
      maybeCached('memory', () => getMemorySection(context)),
      maybeCached('memoryContent', () => getMemoryManager().buildCombinedMemoryPrompt()),
    ].filter((s): s is PromptSection => s !== null)

    // Define all dynamic sections (filtered by profile)
    const dynamicSections: PromptSection[] = [
      maybeVolatile('platform', () => getPlatformSection(context), 'Communication platform-specific guidance'),
      maybeVolatile('sessionGuidance', () => getSessionGuidanceSection(context), 'Session-specific guidance'),
      maybeVolatile('environment', () => getEnvironmentSection(context), 'Changes based on current directory and runtime state'),
      maybeVolatile('language', () => getLanguageSection(context), 'Language preference'),
      maybeVolatile('outputStyle', () => getOutputStyleSection(context), 'Custom output style configuration'),
      maybeVolatile('mcp', () => getMcpInstructionsSection(context), 'MCP servers can connect/disconnect between turns'),
      maybeVolatile('skills', () => getSkillsMetadataSection(context), 'Skills can be loaded/unloaded dynamically'),
      maybeVolatile('scratchpad', () => getScratchpadSection(context), 'Scratchpad directory configuration'),
      maybeVolatile('sessionSearch', () => getSessionSearchSection(context), 'Session search guidance for recalling past conversations'),
      maybeVolatile('widgetGuidelines', () => getWidgetGuidelinesSection(context), 'Widget creation guidelines for generative UI'),
      maybeVolatile('conductorCanvas', () => getConductorCanvasSection(context), 'Canvas workspace context for conductor profile'),
    ].filter((s): s is PromptSection => s !== null)

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

    // Combine: static + boundary + dynamic
    const fullPrompt = [
      ...staticContent,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicContent,
    ]

    return asSystemPrompt(fullPrompt)
  }

  /**
   * Build the prompt context from current runtime state.
   */
  private buildContext(
    enabledTools?: Set<string>,
    mcpServers?: PromptContext['mcpServers'],
  ): PromptContext {
    // Preserve empty string as a valid value (means "no project folder")
    // Only fallback to process.cwd() when explicitly undefined/null
    const workingDirectory = this.options.workingDirectory !== undefined && this.options.workingDirectory !== null
      ? this.options.workingDirectory
      : process.cwd()

    const context: PromptContext = {
      workingDirectory,
      additionalWorkingDirectories: this.options.additionalWorkingDirectories,
      platform: process.platform,
      shell: getShellForPrompt(),
      modelId: this.options.modelId || 'unknown-model',
      enabledTools: enabledTools || new Set(),
      mcpServers,
      sessionStartTime: Date.now(),
      language: this.options.language,
      userType: this.options.userType,
      outputStyleConfig: this.options.outputStyleConfig,
      communicationPlatform: this.options.communicationPlatform,
    }

    return context
  }

  /**
   * Get tool prompt contributions.
   * Override in subclass or pass via constructor for custom tools.
   */
  protected getToolContributions(): ToolPromptContribution[] {
    return this.options.customSections?.map(s => ({
      toolName: s.name,
      usageGuidance: '',
    })) || []
  }

  /**
   * Clear the prompt cache.
   * Call this when session state changes.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get the current cache instance.
   */
  getCache(): PromptCache {
    return this.cache
  }

  /**
   * Update options.
   */
  updateOptions(options: Partial<PromptManagerOptions>): void {
    this.options = { ...this.options, ...options }
  }
}

/**
 * Default prompt manager instance.
 */
let defaultPromptManager: PromptManager | null = null

export function getDefaultPromptManager(): PromptManager {
  if (!defaultPromptManager) {
    defaultPromptManager = new PromptManager()
  }
  return defaultPromptManager
}

export function resetDefaultPromptManager(): void {
  defaultPromptManager = null
}
