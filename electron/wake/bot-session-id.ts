/**
 * electron/wake/bot-session-id.ts — shared bot session id helpers (477 P3.1).
 *
 * A bot's persistent (常驻) session is addressed by a fixed, agent-id-derived
 * session id `bot:<agentId>`. Main and worker both derive it from the agent id,
 * so a bot DM / automation wake can find or create the same session across
 * restarts without an extra binding table. Kept in its own module so both
 * `wake-dispatcher` and `agent-dm-dispatcher` can import it without a cycle.
 */

export const BOT_SESSION_ID_PREFIX = 'bot:'

/** Derive a bot's persistent session id from its agent id. */
export function getBotSessionId(agentId: string): string {
  return `${BOT_SESSION_ID_PREFIX}${agentId}`
}

/** Strip the `bot:` prefix; returns the agent id, or null for non-bot sessions. */
export function parseAgentIdFromBotSession(sessionId: string): string | null {
  return sessionId.startsWith(BOT_SESSION_ID_PREFIX)
    ? sessionId.slice(BOT_SESSION_ID_PREFIX.length)
    : null
}