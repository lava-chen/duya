import type {
  PostToRoomGroup,
  PostToRoomMessage,
  PostToRoomPort,
  ValidatedRoomTarget,
} from '@duya/capabilities/post-to-room-tool';
import { getRoomSessionId, parseAgentIdFromBotSession } from '@duya/agent-protocol/session-ids';
import { listResolvedGroups } from '../worker-prompts/bot/config-groups.js';
import { readConfigAgents } from '../worker-profiles/config-agents.js';
import { isPassContent } from '../group-turn.js';
import { messageDb } from '../worker-db-client.js';

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Bind room membership validation and transcript writes to Host-owned services. */
export function createWorkerRoomMessagingPort(): PostToRoomPort {
  return {
    getSenderSessionId(contextSessionId) {
      return contextSessionId || process.env.SESSION_ID || 'unknown';
    },
    getSenderAgentId(sessionId) {
      return parseAgentIdFromBotSession(sessionId) ?? sessionId;
    },
    isPassContent,
    listResolvedGroups,
    validateRoomTarget(roomId, groups: Readonly<Record<string, PostToRoomGroup>> | null): ValidatedRoomTarget | null {
      if (!roomId || !ROOM_ID_PATTERN.test(roomId)) return null;
      if (groups && !groups[roomId]) return null;
      return { roomId, sessionId: getRoomSessionId(roomId) };
    },
    readConfigAgents,
    async appendMessages(sessionId, messages: PostToRoomMessage[]) {
      return messageDb.append(sessionId, messages);
    },
  };
}
