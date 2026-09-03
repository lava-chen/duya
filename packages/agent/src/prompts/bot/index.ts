/**
 * Bot Prompt Layer — barrel export (Plan 474).
 *
 * Single distilled basic prompt + a self-contained section assembly
 * framework. Not yet wired into DuyaAgent's system-prompt tail: sections
 * are registered as they land (476/477/479/485/481). See catalog.ts for
 * the placeholder skeleton and data-source status.
 */

export { BOT_BASIC_SYSTEM_PROMPT } from './basicPrompt.js'
export {
  BotPromptAssembly,
  fitToBudget,
} from './framework.js'
export type {
  BotPromptContext,
  BotSectionDef,
  BotRosterEntry,
  BotSnapshotKey,
  BotRenderOptions,
  BotPromptConfig,
  BotPromptSectionsFilter,
  BotPromptIdentityConfig,
} from './framework.js'
export {
  computeBotContentHash,
  botSectionCacheKey,
  countTimelineCompactions,
} from './epoch.js'
export { renderBotCommsRules } from './commsRules.js'
export {
  PROFILE_UPDATE_ENVELOPE_TAG,
  PROFILE_UPDATE_ENVELOPE_VERSION,
  buildProfileUpdateEnvelope,
  parseProfileUpdateEnvelope,
  detectProfileUpdate,
  mergeProfileUpdate,
  getLatestProfileUpdate,
  isProfileUpdateFolded,
} from './profileUpdate.js'
export type { ProfileUpdate, ProfileBaseline } from './profileUpdate.js'
export {
  BOT_SECTION_CATALOG,
  registerBotSectionCatalog,
  BOT_IDENTITY_SECTION,
  BOT_COMMS_RULES_SECTION,
  BOT_SPOTLIGHT_SECTION,
  BOT_USER_IDENTITY_SECTION,
  BOT_MEMORY_OWN_DEF,
  BOT_MEMORY_USER_DEF,
  BOT_MEMORY_PROJECT_DEF,
  BOT_AUTOMATIONS_SECTION,
  BOT_CHANNELS_SECTION,
  BOT_ROSTER_SECTION,
  BOT_MCP_SECTION,
  BOT_REMOTE_BOX_SECTION,
} from './catalog.js'
export { renderBotIdentity } from './identity.js'
export { renderBotRoster, BOT_ROSTER_MAX_ENTRIES } from './roster.js'
export { renderBotChannels } from './channels.js'
export { loadBotPromptContext, isBotAgentProfile, loadBotMemoryContext } from './loader.js'
export type { TierMemoryEntry, BotMemoryContext } from './memory/types.js'
export {
  renderMemoryOwn,
  renderMemoryUser,
  renderMemoryProject,
  dedupeTier,
  normalizeKey,
  MEMORY_OWN_MAX_ENTRIES,
  MEMORY_USER_PROFILE_MAX_ENTRIES,
  MEMORY_USER_RECENT_MAX_ENTRIES,
  MEMORY_PROJECT_CAP,
} from './memory/render.js'
export {
  readOwnTierEntries,
  readUserTierEntries,
  readProjectTierEntries,
  readJoinedProjects,
} from './memory/tierReader.js'
export {
  BOT_MEMORY_OWN_SECTION,
  BOT_MEMORY_USER_SECTION,
  BOT_MEMORY_PROJECT_SECTION,
} from './memory/sections.js'

/** Create a bot prompt assembly preloaded with the placeholder catalog. */
export { createBotPromptAssembly } from './factory.js'
