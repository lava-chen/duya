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
} from './framework.js'
export {
  computeBotContentHash,
  botSectionCacheKey,
  countTimelineCompactions,
} from './epoch.js'
export {
  BOT_SECTION_CATALOG,
  registerBotSectionCatalog,
  BOT_IDENTITY_SECTION,
  BOT_SPOTLIGHT_SECTION,
  BOT_USER_IDENTITY_SECTION,
  BOT_MEMORY_SECTION,
  BOT_AUTOMATIONS_SECTION,
  BOT_CHANNELS_SECTION,
  BOT_ROSTER_SECTION,
  BOT_MCP_SECTION,
  BOT_REMOTE_BOX_SECTION,
} from './catalog.js'
export { renderBotIdentity } from './identity.js'
export { renderBotRoster, BOT_ROSTER_MAX_ENTRIES } from './roster.js'
export { loadBotPromptContext, isBotAgentProfile } from './loader.js'

/** Create a bot prompt assembly preloaded with the placeholder catalog. */
export { createBotPromptAssembly } from './factory.js'
