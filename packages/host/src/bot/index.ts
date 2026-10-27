/**
 * bot/ — the Bot application facade as the Host exposes it (framework plan
 * S1 barrel, S2-thinned).
 *
 * The pure core moved to `@duya/bot` (domain rules, journal state machine,
 * application service); what stays here is the Host's file assembly
 * (`service.ts`: TOML store + fs profile + fs JSONL journal adapters) and the
 * re-export of every S1 export name, so `apps/desktop`'s `@duya/host/bot`
 * imports and the worker db bridge are unchanged. The Desktop store-backed
 * assembly lives in the Desktop (`bot-application.ts`) because its config
 * store is Desktop-owned.
 */

export {
  BotServiceError,
  applyIdentityPatch,
  createBotService,
  createHostBotService,
  openBotService,
  openHostBotService,
} from './service.js';
export type {
  BotRepairConflict,
  BotRepairReport,
  BotService,
  BotServicePorts,
} from './service.js';
export { BOT_IDENTITY_JOURNAL_FILENAME } from '@duya/bot';
export { BotIdentityJournal } from './file-journal.js';
export type {
  BotCreateIntent,
  BotIdentityIntent,
  BotUpdateIntent,
  BotUpdatePatch,
  JournalLoadReport,
} from '@duya/bot';
// The port keeps its S1 name on the Host barrel; the domain package calls it
// BotIdentityStorePort (the Desktop store adapter implements either spelling).
export type { BotIdentityStorePort as BotConfigStorePort, BotProfilePort } from '@duya/bot';
