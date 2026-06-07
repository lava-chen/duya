/**
 * Conductor Agent Prompt System
 * Complete prompt system for canvas orchestrator agents
 */

import { createPromptCache } from '../cache.js'
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../types.js'
import type { PromptContext, PromptSection, SystemPrompt, PromptBuildContextOptions } from '../types.js'
import { PromptSystem } from '../PromptSystem.js'
import type { PromptProfile } from '../modes/types.js'
import { isSectionEnabled } from '../modes/index.js'
import { getShellForPrompt } from '../../utils/shellDetector.js'

// Static sections
import {
  getIntroSection,
  getSystemSection,
  getActionsSection,
  getToolUsageSection,
  getCanvasToolsSection,
} from './sections/static/index.js'

// Dynamic sections
import {
  getConductorCanvasSection,
  getEnvironmentSection,
  getVizSpecSection,
} from './sections/dynamic/index.js'

/**
 * Conductor Agent PromptSystem
 * Full-featured prompt system for canvas orchestrator tasks
 */
export class ConductorPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(profile ?? { base: 'full' })
  }

  override getName(): string {
    return 'conductor'
  }

  override clearCache(): void {
    this.cache.clear()
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
    const kept = (
      name: string,
      compute: () => string | null | Promise<string | null>,
    ): PromptSection | null => {
      // Generic section names are gated by profile; conductor-specific names
      // (canvasTools) are always kept.
      const genericNames = new Set(['intro', 'system', 'toolUsage', 'environment'])
      if (genericNames.has(name) && !isSectionEnabled(this.profile, name)) return null
      return { name, compute, volatile: false }
    }

    return [
      kept('intro', () => getIntroSection(context)),
      kept('system', () => getSystemSection(context)),
      kept('toolUsage', () => getToolUsageSection(context)),
      kept('canvasTools', () => getCanvasToolsSection(context)),
    ].filter((s): s is PromptSection => s !== null)
  }

  /**
   * Get dynamic sections (recomputed every turn)
   */
  override getDynamicSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    const kept = (
      name: string,
      compute: () => string | null | Promise<string | null>,
      reason?: string,
    ): PromptSection | null => {
      const genericNames = new Set(['intro', 'system', 'toolUsage', 'environment'])
      if (genericNames.has(name) && !isSectionEnabled(this.profile, name)) return null
      return { name, compute, volatile: true, description: reason }
    }

    return [
      kept('conductorCanvas', () => getConductorCanvasSection(context), 'Canvas workspace context'),
      kept('vizSpec', () => getVizSpecSection(), 'VizSpec format reference'),
      kept('environment', () => getEnvironmentSection(context), 'Current environment info'),
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
   * Build prompt context from options
   */
  override buildContext(options: PromptBuildContextOptions): PromptContext {
    const workingDirectory = options.workingDirectory !== undefined && options.workingDirectory !== null
      ? options.workingDirectory
      : process.cwd()

    return {
      workingDirectory,
      platform: process.platform,
      shell: getShellForPrompt(),
      modelId: options.modelId || 'unknown-model',
      modelName: options.modelName,
      enabledTools: options.enabledTools || new Set(),
      mcpServers: options.mcpServers,
      sessionStartTime: Date.now(),
      language: options.language,
      userType: undefined,
      outputStyleConfig: options.outputStyleConfig,
      communicationPlatform: options.communicationPlatform,
      isWorktree: false,
      isNonInteractiveSession: false,
      isReplModeEnabled: false,
      hasEmbeddedSearchTools: false,
      isForkSubagentEnabled: false,
      isVerificationAgentEnabled: false,
      isSkillSearchEnabled: false,
      scratchpadDir: undefined,
      additionalWorkingDirectories: undefined,
    }
  }
}