/**
 * room-db.ts — shared-room transcript write boundary (Plan 478 P1.2/P2.1).
 *
 * All writes into a room's transcript session (`room:<roomId>`) go through
 * this module so the room-id destination is validated in ONE place: ids are
 * allowlisted by a strict pattern AND must exist in the `groups.toml`
 * declaration (the caller supplies the declaration it validated against).
 * PostToRoomTool (worker) and the main-process room handlers both use it.
 */

import { getRoomSessionId } from '../agent/dm/bot-session-id.js';
import { appendMessages } from './db.js';
import type { ResolvedGroupConfig } from '../agent-profile/config-groups.js';

/**
 * Room-id allowlist pattern. Groups.toml ids are allocated as
 * `group-<hex>`; only identifiers matching this strict shape may address a
 * room session. Anything else (paths, traversal, whitespace, protocol-ish
 * strings) is rejected before any addressing happens.
 */
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Validated room destination — construct only via `validateRoomTarget`. */
export interface ValidatedRoomTarget {
  readonly roomId: string;
  readonly sessionId: string;
}

/**
 * Validate a room id against the allowlist pattern and the declared groups.
 * Returns null when the id is malformed or unknown — callers must treat a
 * null as "no such room" and never derive a session id themselves.
 */
export function validateRoomTarget(
  roomId: string,
  declaredGroups: Readonly<Record<string, ResolvedGroupConfig>> | null,
): ValidatedRoomTarget | null {
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) return null;
  if (declaredGroups && !declaredGroups[roomId]) return null;
  return { roomId, sessionId: getRoomSessionId(roomId) };
}

export interface RoomPostInput {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  source: 'group' | 'group_system' | 'user';
  timestamp: number;
  metadata: Record<string, unknown>;
}

/**
 * Append one authored entry to a VALIDATED room's transcript. The message
 * rides the standard `message:append` bridge: INSERT OR IGNORE idempotency
 * plus a `message:new` SSE broadcast to every renderer (realtime room view).
 */
export async function appendRoomMessage(
  target: ValidatedRoomTarget,
  message: RoomPostInput,
): Promise<{ success: boolean; count: number }> {
  const wireMessage = message as unknown as Parameters<typeof appendMessages>[1][number];
  return appendMessages(target.sessionId, [wireMessage]);
}
