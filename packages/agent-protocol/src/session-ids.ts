/**
 * Stable session-id prefixes shared by runtimes, Hosts, data stores, and
 * clients. These IDs are persisted, so their spelling is a wire contract.
 */

export const BOT_SESSION_ID_PREFIX = 'bot:';
export const ROOM_SESSION_ID_PREFIX = 'room:';

/** Derive a bot's persistent session id from its agent id. */
export function getBotSessionId(agentId: string): string {
  return `${BOT_SESSION_ID_PREFIX}${agentId}`;
}

/** Return the agent id for a bot session, or null for a regular session. */
export function parseAgentIdFromBotSession(sessionId: string): string | null {
  return sessionId.startsWith(BOT_SESSION_ID_PREFIX)
    ? sessionId.slice(BOT_SESSION_ID_PREFIX.length)
    : null;
}

/** Derive a shared room's transcript session id from the room id. */
export function getRoomSessionId(roomId: string): string {
  return `${ROOM_SESSION_ID_PREFIX}${roomId}`;
}

/** Return the room id for a room session, or null for a non-room session. */
export function parseRoomIdFromSession(sessionId: string): string | null {
  return sessionId.startsWith(ROOM_SESSION_ID_PREFIX)
    ? sessionId.slice(ROOM_SESSION_ID_PREFIX.length)
    : null;
}
