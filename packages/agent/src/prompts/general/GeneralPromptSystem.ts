/**
 * General Agent Prompt System
 * Complete prompt system for general-purpose agents
 */

import type {
  PromptContext,
  PromptSection,
  SystemPrompt,
  ToolPromptContribution,
  PromptBuildContextOptions,
} from '../types.js'
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../types.js'
import { PromptSystem } from '../PromptSystem.js'
import { PromptCache, createPromptCache } from '../cache.js'
import { cachedPromptSection, volatilePromptSection } from '../constants/promptSections.js'
import type { PromptProfile } from '../modes/types.js'
import { DEFAULT_PROMPT_PROFILE } from '../modes/index.js'
import { getMemoryManager } from '../../memory/index.js'
import { getShellForPrompt } from '../../utils/shellDetector.js'
import { initializeAgentsMd } from './sections/dynamic/agentsMd.js'
import { getAgentsMdManager } from '../../agentsmd/index.js'

// Static sections
import { getIntroSection } from './sections/static/intro.js'
import { getSystemSection } from './sections/static/system.js'
import { getGeneralTaskGuidanceSection } from './sections/static/generalTaskGuidance.js'
import { getActionsSection } from './sections/static/actions.js'
import { getToolUsageSection } from './sections/static/toolUsage.js'
import { getToneAndStyleSection } from './sections/static/toneAndStyle.js'
import { getOutputEfficiencySection } from './sections/static/outputEfficiency.js'

// Dynamic sections
import { getEnvironmentSection } from './sections/dynamic/environment.js'
import { getMcpInstructionsSection } from './sections/dynamic/mcpInstructions.js'
import { getSessionGuidanceSection } from './sections/dynamic/sessionGuidance.js'
import { getSkillsMetadataSection } from './sections/dynamic/skillsMetadata.js'
import { getLanguageSection } from './sections/dynamic/language.js'
import { getOutputStyleSection } from './sections/dynamic/outputStyle.js'
import { getScratchpadSection } from './sections/dynamic/scratchpad.js'
import { getVisionGuidelinesSection } from './sections/dynamic/visionGuidelines.js'
import { getMemorySection } from './sections/dynamic/memory.js'

/**
 * General Agent PromptSystem
 * Full-featured prompt system for general-purpose tasks
 */
export class GeneralPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(profile ?? DEFAULT_PROMPT_PROFILE)
  }

  override getName(): string {
    return 'general'
  }

  override clearCache(): void {
    this.cache.clear()
  }

  override getCache(): PromptCache {
    return this.cache
  }

  override getProfile(): PromptProfile {
    return { ...this.profile }
  }

  override setProfile(profile: PromptProfile): void {
    this.profile = profile
    this.clearCache()
  }

  /**
   * Get static sections (cached)
   */
  override getStaticSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    const keepCodingInstructions = context.outputStyleConfig?.keepCodingInstructions !== false

    const sections: PromptSection[] = [
      cachedPromptSection('intro', () => getIntroSection(context)),
      cachedPromptSection('system', () => getSystemSection(context)),
      cachedPromptSection('generalTaskGuidance', () => getGeneralTaskGuidanceSection(context)),
      cachedPromptSection('actions', () => getActionsSection(context)),
      cachedPromptSection('toolUsage', () => getToolUsageSection(context, this.getToolContributions())),
      cachedPromptSection('toneAndStyle', () => getToneAndStyleSection(context)),
      keepCodingInstructions
        ? cachedPromptSection('outputEfficiency', () => getOutputEfficiencySection(context))
        : null,
      cachedPromptSection('agentsMd', () => getAgentsMdManager().buildAgentsMdPrompt()),
      cachedPromptSection('memory', () => getMemorySection(context)),
      cachedPromptSection('memoryContent', () => getMemoryManager().buildCombinedMemoryPrompt()),
    ].filter((s): s is PromptSection => s !== null)

    return sections
  }

  /**
   * Get dynamic sections (recomputed every turn)
   */
  override getDynamicSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    return [
      volatilePromptSection('environment', () => getEnvironmentSection(context), 'Current directory state'),
      volatilePromptSection('mcp', () => getMcpInstructionsSection(context), 'MCP servers can change'),
      volatilePromptSection('sessionGuidance', () => getSessionGuidanceSection(context), 'Session-specific guidance'),
      volatilePromptSection('skills', () => getSkillsMetadataSection(context), 'Skills can be loaded/unloaded'),
      volatilePromptSection('language', () => getLanguageSection(context), 'Language preference'),
      volatilePromptSection('outputStyle', () => getOutputStyleSection(context), 'Custom output style'),
      volatilePromptSection('scratchpad', () => getScratchpadSection(context), 'Scratchpad directory'),
      volatilePromptSection('visionGuidelines', () => getVisionGuidelinesSection(context), 'Vision tool guidelines'),
    ].filter((s): s is PromptSection => s !== null)
  }

  /**
   * Build the complete system prompt
   */
  override async buildSystemPrompt(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): Promise<SystemPrompt> {
    // Initialize AGENTS.md
    await initializeAgentsMd(context.workingDirectory)

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
   * Resolve static and dynamic sections
   */
  protected override async resolveSections(
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
   * Get tool prompt contributions
   */
  protected override getToolContributions(): ToolPromptContribution[] {
    return []
  }

  /**
   * Build prompt context from options
   */
  override buildContext(options: PromptBuildContextOptions): PromptContext {
    const workingDirectory = options.workingDirectory !== undefined && options.workingDirectory !== null
      ? options.workingDirectory
      : process.cwd()

    return {
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
    }
  }
}