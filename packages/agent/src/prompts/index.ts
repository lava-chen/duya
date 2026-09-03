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
  DEFAULT_SUBAGENT_PROFILE,
  SUBAGENT_TYPE_PROFILE_MAP,
} from './modes/index.js'

export type { PromptProfile } from './modes/types.js'
export type { ResearchTaskIntent, ResearchPromptRuntimeContext } from './research/types.js'

// Shared sections (used by multiple configs)
export { getProjectContinuitySection } from './sections/projectContinuity.js'
export { getConfigProtectionSection } from './general/sections/configProtection.js'

// Dynamic Sections
export { getEnvironmentSection } from './sections/dynamic/environment.js'
export { getMcpInstructionsSection } from './sections/dynamic/mcpInstructions.js'
export { getSessionGuidanceSection } from './sections/dynamic/sessionGuidance.js'
export { getSkillsMetadataSection } from './sections/dynamic/skillsMetadata.js'
export { getLanguageSection } from './sections/dynamic/language.js'
export { getScratchpadSection } from './sections/dynamic/scratchpad.js'
export { getOutputStyleSection } from './sections/dynamic/outputStyle.js'
export { getRecentSessionsSection } from './sections/dynamic/recentSessionsSection.js'
export { initializeAgentsMd } from './sections/dynamic/agentsMdSection.js'

// Vision Guidelines
export { getVisionGuidelinesSection } from './sections/dynamic/visionGuidelines.js'

// Platform Hints
export { getPlatformHint, PLATFORM_HINTS } from './platformHints.js'

// Bot prompt layer (Plan 474) — config-driven bot system-prompt sections.
export { BOT_BASIC_SYSTEM_PROMPT } from './bot/index.js'
export { BotPromptAssembly, fitToBudget } from './bot/index.js'
export type {
  BotPromptContext,
  BotSectionDef,
  BotRosterEntry,
  BotSnapshotKey,
  BotRenderOptions,
  BotPromptConfig,
  BotPromptSectionsFilter,
  BotPromptIdentityConfig,
} from './bot/index.js'
export {
  computeBotContentHash,
  botSectionCacheKey,
  countTimelineCompactions,
} from './bot/index.js'
export { createBotPromptAssembly } from './bot/index.js'
export {
  registerBotSectionCatalog,
  BOT_SECTION_CATALOG,
} from './bot/index.js'
export { renderBotIdentity } from './bot/index.js'
export { renderBotRoster, BOT_ROSTER_MAX_ENTRIES } from './bot/index.js'
export { loadBotPromptContext, isBotAgentProfile } from './bot/index.js'
