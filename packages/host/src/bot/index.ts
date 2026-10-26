/**
 * bot/ — the Bot application facade (framework plan S1).
 *
 * `service.ts` is the use-case surface; `journal.ts` the durable identity
 * intents; `ports.ts` the storage seams. The standalone Host's file-backed
 * assembly lives in `service.ts` (`openHostBotService`); the Desktop
 * store-backed assembly lives in the Desktop (`bot-application.ts`) because
 * its config store is Desktop-owned — the same reason S2 will move the pure
 * core into `packages/bot` and leave both adapters behind.
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
export {
  BOT_IDENTITY_JOURNAL_FILENAME,
  BotIdentityJournal,
} from './journal.js';
export type {
  BotCreateIntent,
  BotIdentityIntent,
  BotUpdateIntent,
  BotUpdatePatch,
  JournalLoadReport,
} from './journal.js';
export type { BotConfigStorePort, BotProfilePort } from './ports.js';
