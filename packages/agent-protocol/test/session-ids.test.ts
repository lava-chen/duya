import { describe, expect, it } from 'vitest';
import {
  BOT_SESSION_ID_PREFIX,
  ROOM_SESSION_ID_PREFIX,
  getBotSessionId,
  getRoomSessionId,
  parseAgentIdFromBotSession,
  parseRoomIdFromSession,
} from '../src/session-ids.js';

describe('persisted session IDs', () => {
  it('uses stable bot session IDs and parses only the bot prefix', () => {
    expect(BOT_SESSION_ID_PREFIX).toBe('bot:');
    expect(getBotSessionId('helper')).toBe('bot:helper');
    expect(parseAgentIdFromBotSession('bot:helper')).toBe('helper');
    expect(parseAgentIdFromBotSession('session:helper')).toBeNull();
  });

  it('uses stable room session IDs and parses only the room prefix', () => {
    expect(ROOM_SESSION_ID_PREFIX).toBe('room:');
    expect(getRoomSessionId('planning')).toBe('room:planning');
    expect(parseRoomIdFromSession('room:planning')).toBe('planning');
    expect(parseRoomIdFromSession('bot:planning')).toBeNull();
  });
});
