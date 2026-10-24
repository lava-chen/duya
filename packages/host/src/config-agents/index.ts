/**
 * config-agents — the custom-agent config surface.
 *
 * Read side (`readConfigAgents`) lives next door in `agent-profile-config.ts`;
 * this directory owns the shape, the rules and the write side.
 */

export {
  BOT_ID_PATTERN,
  assertValidBotId,
  findInvalidBotIds,
  isSafeBotId,
} from './bot-id.js';
export {
  getBotDeletedAgentDir,
  getBotDeletedDir,
  getBotMemoryDir,
  getBotProfilePath,
  getBotSessionsDir,
  getBotSessionLogPath,
  getBotSettingsPath,
  getBotStateDir,
  getDuyaAgentsRoot,
  resolveDuyaAgentDir,
} from './bot-paths.js';
export {
  BOT_PROFILE_FILENAME,
  BOT_PROFILE_SCHEMA_VERSION,
  readBotProfile,
  writeBotProfile,
} from './bot-profile.js';
export type {
  BotProfile,
  BotProfileInput,
  ProfileMigrationHook,
} from './bot-profile.js';
export type {
  AgentIdentityPatch,
  AgentUpsertInput,
  CreatedConfigAgent,
  CustomAgentConfig,
  CustomAgentPromptConfig,
  CustomAgentPromptIdentityConfig,
  CustomAgentPromptSectionsConfig,
  CustomAgentToolsConfig,
} from './agent-config-schema.js';
export {
  allocateBotId,
  assertConfigAgentId,
  buildUpsertedAgent,
  collectTakenBotIdsFromDisk,
  isSoftDeletedConfigAgent,
  mergeTakenBotIds,
  seedBotProfileIfMissing,
  slugifyBotIdFromName,
} from './agent-config-core.js';
export {
  readAgentsTable,
  readConfigTomlDocument,
  writeConfigAgentsTable,
  writeConfigTomlDocument,
} from './config-file.js';
export type { ConfigTomlDocument } from './config-file.js';
export {
  createConfigAgent,
  updateConfigAgentIdentity,
} from './config-agents-api.js';
export type {
  ConfigAgentIdentity,
  ConfigAgentsLogger,
  ConfigAgentsWriteOptions,
} from './config-agents-api.js';
