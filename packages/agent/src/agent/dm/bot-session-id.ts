/**
 * Bot persistent session id helpers (Plan 477 P3.1).
 *
 * A bot's persistent (常驻) session is addressed by a fixed, agent-id-derived
 * session id `bot:<agentId>`. Both main and worker derive it from the agent
 * id, so a bot DM / automation wake can find or create the same session
 * across restarts without an extra binding table. Dependency-free so both
 * the agent bundle and the Electron main process can import it without a
 * cycle (`electron/wake/bot-session-id.ts` re-exports this module).
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
