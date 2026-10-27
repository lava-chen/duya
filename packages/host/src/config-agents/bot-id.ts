/**
 * bot-id.ts — Bot agent id validation (Host re-export).
 *
 * The rules moved to `@duya/bot` (framework plan S2) so the Desktop config
 * store and the standalone Host keep agreeing on what a legal bot id is from
 * ONE definition. A bot id is also a directory name under
 * `<duyaRoot>/agents/<id>`, so the check is a path-safety boundary, not a
 * naming preference. This module keeps the Host's internal import path
 * (`bot-paths.ts` and the config-agents barrel) stable.
 */

export {
  BOT_ID_PATTERN,
  assertValidBotId,
  findInvalidBotIds,
  isSafeBotId,
} from '@duya/bot';
