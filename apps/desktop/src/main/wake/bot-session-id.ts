/** Compatibility module for callers migrating to the shared Protocol contract. */
export {
  BOT_SESSION_ID_PREFIX,
  ROOM_SESSION_ID_PREFIX,
  getBotSessionId,
  parseAgentIdFromBotSession,
  getRoomSessionId,
  parseRoomIdFromSession,
} from '@duya/agent-protocol';
