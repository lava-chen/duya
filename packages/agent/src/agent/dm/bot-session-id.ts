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
/** Plan 478: shared-room transcript session id prefix. */
export const ROOM_SESSION_ID_PREFIX = 'room:'

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

/**
 * Plan 478: derive a shared room's transcript session id from the room id
 * (`room:<roomId>`). A room session stores the group transcript only — no
 * agent ever runs on it (the orchestrator wakes member sessions instead).
 * Ids are validated by the callers against the groups.toml declaration.
 */
export function getRoomSessionId(roomId: string): string {
  return `${ROOM_SESSION_ID_PREFIX}${roomId}`
}

/** Strip the `room:` prefix; returns the room id, or null for non-room sessions. */
export function parseRoomIdFromSession(sessionId: string): string | null {
  return sessionId.startsWith(ROOM_SESSION_ID_PREFIX)
    ? sessionId.slice(ROOM_SESSION_ID_PREFIX.length)
    : null
}
