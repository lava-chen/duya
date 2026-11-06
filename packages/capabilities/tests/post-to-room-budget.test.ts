import { describe, it, expect, beforeEach } from 'vitest';
import {
  PostToRoomTool,
  _resetPostToRoomLimiterForTest,
  type PostToRoomPort,
  type PostToRoomGroup,
} from '../src/post-to-room-tool';
import type { ToolUseContext } from '../src/contracts/tool';

const ROOM_ID = 'room-1';
const GROUPS: Record<string, PostToRoomGroup> = {
  [ROOM_ID]: { id: ROOM_ID, name: 'Room One', memberIds: ['session-a', 'session-b'] },
};

function createPort(): PostToRoomPort & { appended: Array<{ sessionId: string; text: string }> } {
  const appended: Array<{ sessionId: string; text: string }> = [];
  return {
    appended,
    getSenderSessionId: (contextSessionId?: string) => contextSessionId ?? '',
    getSenderAgentId: (sessionId: string) => sessionId,
    isPassContent: (text: string) => text.trim() === '(pass)',
    listResolvedGroups: async () => GROUPS,
    validateRoomTarget: (roomId: string, groups: Readonly<Record<string, PostToRoomGroup>> | null) =>
      groups?.[roomId] ? { roomId, sessionId: `room:${roomId}` } : null,
    readConfigAgents: async () => ({}),
    appendMessages: async (sessionId: string, messages: Array<{ content: string }>) => {
      appended.push({ sessionId, text: messages[0]?.content ?? '' });
      return undefined;
    },
  };
}

function contextFor(sessionId: string): ToolUseContext {
  return { options: { sessionId } } as unknown as ToolUseContext;
}

const post = (tool: PostToRoomTool, sessionId: string, text: string) =>
  tool.execute({ roomId: ROOM_ID, text }, undefined, contextFor(sessionId));

describe('PostToRoom per-turn budget', () => {
  beforeEach(() => _resetPostToRoomLimiterForTest());

  it('caps one session at two messages per turn', async () => {
    const port = createPort();
    const tool = new PostToRoomTool(port);

    expect((await post(tool, 'session-a', 'one')).error).toBeFalsy();
    expect((await post(tool, 'session-a', 'two')).error).toBeFalsy();
    const third = await post(tool, 'session-a', 'three');

    expect(third.result).toContain('Room message limit reached');
    expect(port.appended.map((e) => e.text)).toEqual(['one', 'two']);
  });

  // The regression: one process serves every session it is asked to serve, so a
  // process-wide budget let member A's two messages end member B's turn.
  it('gives each session its own allowance', async () => {
    const port = createPort();
    const tool = new PostToRoomTool(port);

    await post(tool, 'session-a', 'a-one');
    await post(tool, 'session-a', 'a-two');
    expect((await post(tool, 'session-a', 'a-three')).result).toContain('limit reached');

    expect((await post(tool, 'session-b', 'b-one')).error).toBeFalsy();
    expect((await post(tool, 'session-b', 'b-two')).error).toBeFalsy();
    expect(port.appended.map((e) => e.text)).toEqual(['a-one', 'a-two', 'b-one', 'b-two']);
  });

  it('does not charge the budget for a pass', async () => {
    const port = createPort();
    const tool = new PostToRoomTool(port);

    await post(tool, 'session-a', '(pass)');
    await post(tool, 'session-a', '(pass)');
    expect((await post(tool, 'session-a', 'spoken')).error).toBeFalsy();
    expect(port.appended.map((e) => e.text)).toEqual(['spoken']);
  });
});
