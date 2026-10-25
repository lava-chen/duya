/**
 * @duya/bot — the pure Bot domain package (framework plan S2).
 *
 * The Bot identity domain in one place: the `[agents.<id>]` entry shapes, the
 * bot-id path-safety rules, the identity rules (upsert merge, patch apply,
 * canonical view), the identity journal's pure state machine, the storage
 * ports, and the identity application service. ZERO IO — every `node:*`
 * module stays behind a Host adapter (`packages/host/src/bot/`); the package's
 * only dependency is `@duya/agent-protocol` (the wire DTOs).
 *
 * Layering: `host -> bot -> agent-protocol` is the only legal direction; the
 * S0 bot-boundary gate measures it.
 */

// ── domain: identity shapes ─────────────────────────────────────────────────
export type {
  AgentUpsertInput,
  BotIdentityEntry,
  BotUpdatePatch,
  CustomAgentPromptConfig,
  CustomAgentPromptIdentityConfig,
  CustomAgentPromptSectionsConfig,
  CustomAgentToolsConfig,
} from './domain/identity.js';

// ── domain: bot id rules ────────────────────────────────────────────────────
export {
  BOT_ID_PATTERN,
  assertValidBotId,
  findInvalidBotIds,
  isSafeBotId,
} from './domain/bot-id.js';

// ── domain: runtime profile shapes ─────────────────────────────────────────
export { BOT_PROFILE_SCHEMA_VERSION } from './domain/profile.js';
export type { BotProfile, BotProfileInput } from './domain/profile.js';

// ── domain: identity rules ──────────────────────────────────────────────────
export {
  allocateBotId,
  applyIdentityPatch,
  buildUpsertedAgent,
  canonicalBotRecord,
  isSoftDeletedConfigAgent,
  slugifyBotIdFromName,
} from './domain/rules.js';

// ── domain: service error ───────────────────────────────────────────────────
export { BotServiceError } from './domain/errors.js';
export type { BotErrorCode } from '@duya/agent-protocol/bot-api';

// ── journal: pure state machine + in-memory implementation ─────────────────
export {
  BOT_IDENTITY_JOURNAL_FILENAME,
  BotIdentityJournalState,
  InMemoryBotIdentityJournal,
  isJournalRecord,
} from './journal/journal.js';
export type {
  AppliedMarker,
  BotCreateIntent,
  BotIdentityIntent,
  BotUpdateIntent,
  JournalLoadReport,
} from './journal/journal.js';

// ── ports ───────────────────────────────────────────────────────────────────
export type {
  BotIdentityJournalPort,
  BotIdentityStorePort,
  BotProfilePort,
} from './ports/ports.js';

// ── application ─────────────────────────────────────────────────────────────
export { createBotService, openBotService } from './application/service.js';
export type {
  BotRepairConflict,
  BotRepairReport,
  BotService,
  BotServicePorts,
} from './application/service.js';
