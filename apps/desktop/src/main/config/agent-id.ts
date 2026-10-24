/**
 * agent-id.ts — Bot agent id validation.
 *
 * The rules live in `@duya/host/config-agents` so the Desktop config store
 * and the standalone Host agree on what a legal bot id is. A bot id is also
 * a directory name under `<duyaRoot>/agents/<id>`, so the check is a
 * path-safety boundary, not a naming preference.
 */

export {
  BOT_ID_PATTERN,
  assertValidBotId,
  findInvalidBotIds,
  isSafeBotId,
} from '@duya/host/config-agents';
