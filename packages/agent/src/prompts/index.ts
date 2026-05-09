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

// Sections (for direct access if needed)
export { getIntroSection } from './sections/intro.js'
export { getSystemSection } from './sections/system.js'
export { getTaskHandlingSection } from './sections/taskHandling.js'
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

// Platform Hints
export { getPlatformHint, hasPlatformCapability, PLATFORM_HINTS } from './platformHints.js'
