/**
 * room-session.ts — renderer-side room session id helpers (Plan 478).
 *
 * Mirrors `packages/agent/src/agent/dm/bot-session-id.ts` (the worker/main
 * single source of truth) so the renderer can parse `room:<roomId>` thread
 * ids without importing agent internals.
 */

export const ROOM_SESSION_ID_PREFIX = "room:";

/** Derive a room's transcript session id from the room id. */
export function getRoomSessionId(roomId: string): string {
  return `${ROOM_SESSION_ID_PREFIX}${roomId}`;
}

/** Strip the `room:` prefix; null for non-room session ids. */
export function parseRoomIdFromSession(sessionId: string): string | null {
  return sessionId.startsWith(ROOM_SESSION_ID_PREFIX)
    ? sessionId.slice(ROOM_SESSION_ID_PREFIX.length)
    : null;
}
