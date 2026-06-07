import type {
  PromptBuildContextOptions,
  PromptContext,
  PromptSection,
  SystemPrompt,
  ToolPromptContribution,
} from '../types.js'
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../types.js'
import { PromptSystem } from '../PromptSystem.js'
import type { PromptProfile } from '../modes/types.js'
import { DEFAULT_PROMPT_PROFILE, isSectionEnabled } from '../modes/index.js'
import { cachedPromptSection, volatilePromptSection } from '../constants/promptSections.js'
import { getShellForPrompt } from '../../utils/shellDetector.js'
import { resolveResearchIntent } from './intentRouter.js'
import { getResearchProfileSection } from './sections/profile.js'
import { getTaskIntentPromptSection } from './sections/taskIntent.js'
import { getLiteraturePluginToolPromptSection } from './sections/literatureTool.js'
import { getResearchMemoryContextPromptSection } from './sections/researchMemoryContext.js'
import { getEvidencePolicyPromptSection } from './sections/evidencePolicy.js'
import { getOutputFormatPromptSection } from './sections/outputFormat.js'
import { getMemoryWriteProposalPromptSection } from './sections/memoryWriteProposal.js'
import { getToneAndStylePromptSection } from './sections/toneAndStyle.js'
import type { ResearchTaskIntent } from './types.js'

export class ResearchPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(profile ?? DEFAULT_PROMPT_PROFILE)
  }

  override getName(): string {
    return 'research'
  }

  override getStaticSections(_context: PromptContext): PromptSection[] {
    const m = (name: string, compute: () => string | null | Promise<string | null>): PromptSection | null => {
      if (!isSectionEnabled(this.profile, name)) return null
      return cachedPromptSection(name, compute)
    }

    return [
      // Research-specific sections are not gated by isSectionEnabled — they
      // exist outside the generic section registry. Override `getProfile` /
      // bespoke gating here if you need to disable a research-specific block.
      cachedPromptSection('researchProfile', () => getResearchProfileSection(_context)),
      cachedPromptSection('taskIntent', () => getTaskIntentPromptSection()),
      cachedPromptSection('literaturePluginToolPolicy', () => getLiteraturePluginToolPromptSection()),
      cachedPromptSection('evidencePolicy', () => getEvidencePolicyPromptSection()),
      cachedPromptSection('memoryWriteProposal', () => getMemoryWriteProposalPromptSection()),
      // toneAndStyle IS a generic section name; respect the profile gate so
      // presets like 'bare' (which disables toneAndStyle) take effect.
      m('toneAndStyle', () => getToneAndStylePromptSection(_context)),
    ].filter((s): s is PromptSection => s !== null)
  }

  override getDynamicSections(context: PromptContext): PromptSection[] {
    const intent = resolveResearchIntent(context)
    return [
      volatilePromptSection(
        'researchMemoryContext',
        () => getResearchMemoryContextPromptSection(context),
        'Intent-scoped research memory context',
      ),
      volatilePromptSection(
        'outputFormat',
        () => getOutputFormatPromptSection(intent),
        'Intent-specific output format',
      ),
    ]
  }

  override async buildSystemPrompt(context: PromptContext): Promise<SystemPrompt> {
    const staticSections = this.getStaticSections(context)
    const dynamicSections = this.getDynamicSections(context)
    const { staticContent, dynamicContent } = await this.resolveSections(staticSections, dynamicSections)
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
    const workingDirectory = options.workingDirectory || process.cwd()
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
      researchIntent: options.researchIntent as ResearchTaskIntent | undefined,
      researchProjectId: options.researchProjectId,
    }
  }
}

