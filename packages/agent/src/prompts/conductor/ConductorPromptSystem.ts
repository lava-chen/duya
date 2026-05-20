/**
 * Conductor Agent Prompt System
 * Complete prompt system for canvas orchestrator agents
 */

import { createPromptCache } from '../cache.js'
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../types.js'
import type { PromptContext, PromptSection, SystemPrompt } from '../types.js'
import type { PromptProfile } from '../modes/types.js'
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
export class ConductorPromptSystem {
  protected cache = createPromptCache()
  protected profile: PromptProfile

  constructor(profile?: PromptProfile) {
    this.profile = profile ?? { base: 'full' }
  }

  getName(): string {
    return 'conductor'
  }

  clearCache(): void {
    this.cache.clear()
  }

  getProfile(): PromptProfile {
    return { ...this.profile }
  }

  setProfile(profile: PromptProfile): void {
    this.profile = profile
    this.clearCache()
  }

  /**
   * Get static sections (cached)
   */
  getStaticSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    const sections: PromptSection[] = [
      {
        name: 'intro',
        compute: () => getIntroSection(context),
        volatile: false,
      },
      {
        name: 'system',
        compute: () => getSystemSection(context),
        volatile: false,
      },
      {
        name: 'toolUsage',
        compute: () => getToolUsageSection(context),
        volatile: false,
      },
      {
        name: 'canvasTools',
        compute: () => getCanvasToolsSection(),
        volatile: false,
      },
    ]
    return sections
  }

  /**
   * Get dynamic sections (recomputed every turn)
   */
  getDynamicSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    const sections: PromptSection[] = [
      {
        name: 'conductorCanvas',
        compute: () => getConductorCanvasSection(context),
        volatile: true,
        description: 'Canvas workspace context',
      },
      {
        name: 'vizSpec',
        compute: () => getVizSpecSection(),
        volatile: true,
        description: 'VizSpec format reference',
      },
      {
        name: 'environment',
        compute: () => getEnvironmentSection(context),
        volatile: true,
        description: 'Current environment info',
      },
    ]
    return sections
  }

  /**
   * Build the complete system prompt
   */
  async buildSystemPrompt(
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
   * Build prompt context from options
   */
  buildContext(options: {
    workingDirectory?: string
    modelId?: string
    modelName?: string
    enabledTools?: Set<string>
    mcpServers?: PromptContext['mcpServers']
    language?: string
    outputStyleConfig?: PromptContext['outputStyleConfig']
    communicationPlatform?: PromptContext['communicationPlatform']
  }): PromptContext {
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