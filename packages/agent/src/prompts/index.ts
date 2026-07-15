/**
 * Prompt Engineering System - Main Export
 */

// Types
export type {
  SystemPrompt,
  PromptSection,
  ResolvedPromptSection,
  PromptContext,
  PromptFeatureFlags,
  ToolPromptContribution,
  PromptManagerOptions,
  OutputStyleConfig,
  MCPServerConnection,
  PromptBuildContextOptions,
} from './types.js'

export {
  asSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  DEFAULT_SYSTEM_PROMPT,
  CYBER_RISK_INSTRUCTION,
  KNOWLEDGE_CUTOFFS,
  TOOL_NAMES,
  MODEL_CONSTANTS,
} from './types.js'

// Cache
export { PromptCache, createPromptCache } from './cache.js'

// Constants
export { cachedPromptSection, volatilePromptSection, prependBullets } from './constants/promptSections.js'

// Manager
export { PromptManager, getDefaultPromptManager, resetDefaultPromptManager } from './PromptManager.js'

// Prompt System base + registry
export { PromptSystem } from './PromptSystem.js'
export { PromptsRegistry, resolvePromptSystemName } from './registry.js'

// Modes & Profile
export {
  resolveEnabledSections,
  isSectionEnabled,
  resolveEnabledSectionsForAgentProfile,
  getPromptProfileForAgentProfile,
  getPromptProfileForSubagentType,
  applyProfileOverrides,
  DEFAULT_PROMPT_PROFILE,
  DEFAULT_BASE_SECTION_SETS,
  SUBAGENT_TYPE_PROFILE_MAP,
} from './modes/index.js'

export type { PromptBaseMode, PromptOverlay, PromptProfile } from './modes/types.js'
export type { ResearchTaskIntent, ResearchPromptRuntimeContext } from './research/types.js'
export { getSystemSection } from './sections/system.js'
export { getGeneralTaskGuidanceSection } from './sections/generalTaskGuidance.js'
export { getTaskHandlingSection } from './sections/taskHandling.js'
export {
  getProjectContinuitySection,
  getProjectGroundingSection,
} from './sections/projectGrounding.js'
export { getActionsSection } from './sections/actions.js'
export { getToolUsageSection } from './sections/toolUsage.js'
export { getToneAndStyleSection } from './sections/toneAndStyle.js'
export { getOutputEfficiencySection } from './sections/outputEfficiency.js'

// Dynamic Sections
export { getEnvironmentSection } from './sections/dynamic/environment.js'
export { getMcpInstructionsSection } from './sections/dynamic/mcpInstructions.js'
export { getSessionGuidanceSection } from './sections/dynamic/sessionGuidance.js'
export { getSkillsMetadataSection } from './sections/dynamic/skillsMetadata.js'
export { getLanguageSection } from './sections/dynamic/language.js'
export { getScratchpadSection } from './sections/dynamic/scratchpad.js'
export { getOutputStyleSection } from './sections/dynamic/outputStyle.js'
export {
  getAgentsMdSection,
  initializeAgentsMd,
  getAgentsMdGuidanceSection,
} from './sections/dynamic/agentsMdSection.js'

// Widget Guidelines
export { getWidgetGuidelinesSection } from './sections/dynamic/widgetGuidelines.js'

// Vision Guidelines
export { getVisionGuidelinesSection } from './sections/dynamic/visionGuidelines.js'

// Platform Hints
export { getPlatformHint, hasPlatformCapability, PLATFORM_HINTS } from './platformHints.js'
