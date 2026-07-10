/**
 * Gateway Agent Prompt System
 *
 * Minimal prompt system for the gateway relay agent. Unlike
 * GeneralPromptSystem (which renders a large duya_cli self-management
 * manual plus task/action/tool-usage guidance), this system renders
 * only what a stateless IM relay needs:
 *
 *   static:  intro (identity) → gatewayRole (behaviour) → system (ops)
 *            → toneAndStyle
 *   dynamic: platform (channel hints) → language
 *
 * It deliberately omits: generalTaskGuidance, actions, toolUsage,
 * agentsMd, memory, environment, mcp, skills, scratchpad,
 * visionGuidelines, outputEfficiency — none of these help a relay
 * agent and several actively mislead it into doing work itself.
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
import { cachedPromptSection, volatilePromptSection } from '../constants/promptSections.js'
import type { PromptProfile } from '../modes/types.js'
import { DEFAULT_PROMPT_PROFILE } from '../modes/index.js'
import { getShellForPrompt } from '../../utils/shellDetector.js'

// Gateway-specific static sections
import { getGatewayIntroSection, getGatewayRoleSection } from './sections/static/index.js'

// Reused sections from the general system
import { getSystemSection } from '../general/sections/static/system.js'
import { getToneAndStyleSection } from '../general/sections/static/toneAndStyle.js'

// Reused dynamic sections
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getLanguageSection } from '../general/sections/dynamic/language.js'

export class GatewayPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(profile ?? DEFAULT_PROMPT_PROFILE)
  }

  override getName(): string {
    return 'gateway'
  }

  override getStaticSections(_context: PromptContext): PromptSection[] {
    return [
      cachedPromptSection('intro', () => getGatewayIntroSection(_context)),
      cachedPromptSection('gatewayRole', () => getGatewayRoleSection()),
      cachedPromptSection('system', () => getSystemSection(_context)),
      cachedPromptSection('toneAndStyle', () => getToneAndStyleSection(_context)),
    ]
  }

  override getDynamicSections(context: PromptContext): PromptSection[] {
    return [
      volatilePromptSection(
        'platform',
        () => getPlatformSection(context),
        'Channel-specific formatting/media hints',
      ),
      volatilePromptSection(
        'language',
        () => getLanguageSection(context),
        'Language preference',
      ),
    ]
  }

  override async buildSystemPrompt(context: PromptContext): Promise<SystemPrompt> {
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

  protected override getToolContributions(): ToolPromptContribution[] {
    return []
  }

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
