/**
 * bot-session-id.ts — re-export of the shared bot session id helpers
 * (single source of truth lives in `packages/agent/src/agent/dm/bot-session-id.ts`
 * so the worker's SendToAgent tool and main's wake bus address the same
 * `bot:<agentId>` persistent sessions).
 */

export {
  BOT_SESSION_ID_PREFIX,
  getBotSessionId,
  parseAgentIdFromBotSession,
} from '../../packages/agent/src/agent/dm/bot-session-id'
