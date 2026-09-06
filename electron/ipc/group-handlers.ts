/**
 * group-handlers.ts — shared-room IPC surface (Plan 478 P1.1/P2.2/P3.1).
 *
 *  - `config:groups:*`   — groups.toml CRUD (rooms are config-side logical
 *                          rooms; plan 478 §2.1).
 *  - `room:ensure`       — idempotently create the room's transcript session
 *                          row so the renderer can open the room view.
 *  - `room:post`         — append the user's authored entry to the room
 *                          transcript and schedule a group turn (user lane;
 *                          interrupts an in-flight member run).
 *  - `room:getTranscript`— source-filtered room projection
 *                          (user + group + group_system rows).
 *  - `room:members`      — resolved member list for the room header/picker.
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  updateGroup,
  GroupValidationError,
} from '../config/groups';
import { listConfigAgents } from '../config/agents';
import { getCoreStores } from '../db/core-connection';
import { storedEventToIpcMessage } from './core-db-adapters';
import { ROOM_VISIBLE_SOURCES } from '../../packages/agent/src/message/message-source';
import {
  appendRoomEntry,
  ensureRoomSession,
  scheduleGroupTurn,
} from '../wake/group-turn-dispatcher';
import { getRoomSessionId } from '../../packages/agent/src/agent/dm/bot-session-id';
import { getLogger, LogComponent } from '../logging/logger';
import { parseRoomIdFromSession } from '../../packages/agent/src/agent/dm/bot-session-id';

/** Accept both a bare room id and the full `room:<roomId>` session id. */
function normalizeRoomId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return parseRoomIdFromSession(value) ?? value;
}

export function registerGroupHandlers(): void {
  // ─── groups.toml CRUD ───

  ipcMain.handle('config:groups:list', async () => {
    return listGroups();
  });

  ipcMain.handle('config:groups:get', async (_event, id: string) => {
    return getGroup(id);
  });

  ipcMain.handle(
    'config:groups:create',
    (_event, input: { name: string; memberIds: string[]; maxRounds?: number; maxMemberTurns?: number }) => {
      try {
        return Promise.resolve(createGroup(input));
      } catch (err) {
        if (err instanceof GroupValidationError) throw new Error(err.message);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'config:groups:update',
    (_event, id: string, patch: { name?: string; memberIds?: string[]; maxRounds?: number; maxMemberTurns?: number }) => {
      try {
        return Promise.resolve(updateGroup(id, patch));
      } catch (err) {
        if (err instanceof GroupValidationError) throw new Error(err.message);
        throw err;
      }
    },
  );

  ipcMain.handle('config:groups:delete', (_event, id: string) => {
    return Promise.resolve(deleteGroup(id));
  });

  // ─── Room transcript surface ───

  ipcMain.handle('room:ensure', async (_event, roomId: unknown) => {
    const id = normalizeRoomId(roomId);
    const group = await getGroup(id);
    const sessionId = ensureRoomSession(id, group?.name ?? id);
    getLogger().debug('Room ensured', { roomId: id, sessionId }, LogComponent.AgentProcess);
    return sessionId;
  });

  ipcMain.handle('room:post', (_event, data: { roomId: string; text: string }) => {
    const roomId = normalizeRoomId(data?.roomId);
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!roomId) throw new Error('roomId is required');
    if (!text) throw new Error('text is required');

    const sessionId = ensureRoomSession(roomId, roomId);
    appendRoomEntry(sessionId, {
      id: randomUUID(),
      role: 'user',
      content: text,
      source: 'user',
      metadata: { source: 'user' },
    });
    // User lane: voids the remaining speaker plan and interrupts the
    // in-flight member run (plan 478 §2.4).
    scheduleGroupTurn(roomId, 'user');
    return { ok: true };
  });

  ipcMain.handle('room:getTranscript', (_event, roomId: unknown) => {
    const { messageLog } = getCoreStores();
    const sessionId = getRoomSessionId(normalizeRoomId(roomId));
    const events = messageLog.listBySession(sessionId, { source: ROOM_VISIBLE_SOURCES });
    return events
      .map((event) => storedEventToIpcMessage(event))
      .filter((row) => row !== null);
  });

  ipcMain.handle('room:members', async (_event, roomId: unknown) => {
    const group = await getGroup(normalizeRoomId(roomId));
    if (!group) return [];
    const agents = listConfigAgents();
    return group.memberIds.map((id) => ({
      id,
      name: agents[id]?.name || id,
      description: agents[id]?.description || '',
    }));
  });
}
