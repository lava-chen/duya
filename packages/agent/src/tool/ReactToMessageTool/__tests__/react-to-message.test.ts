/**
 * Plan 490 P1 — ReactToMessage tool tests.
 *
 * The execute path depends on the db-bridge (messageDb.getBySession /
 * messageDb.append); these tests inject a fake db-client module via
 * vi.mock so the toggle semantics, target validation and error codes are
 * covered deterministically without a real MessageLog.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fakeState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  appended: [] as Array<{ sessionId: string; messages: unknown[] }>,
}));

vi.mock('../../../ipc/db-client.js', () => ({
  messageDb: {
    getBySession: (sessionId: string) => {
      if (sessionId === '__bridge_error__') {
        return Promise.reject(new Error('bridge down'));
      }
      return Promise.resolve(fakeState.rows);
    },
    append: (sessionId: string, messages: unknown[]) => {
      fakeState.appended.push({ sessionId, messages });
      return Promise.resolve({ success: true, count: 1 });
    },
  },
}));

import { reactToMessageTool, resolveReactToMessage } from '../ReactToMessageTool.js';
import { REACT_TO_MESSAGE_TOOL_NAME } from '../constants.js';
import type { ToolUseContext } from '../../../types.js';

function makeContext(overrides: Record<string, unknown> = {}): ToolUseContext {
  return {
    toolUseId: 't-react',
    getAppState: (() => ({})) as ToolUseContext['getAppState'],
    setAppState: () => {},
    abortController: new AbortController(),
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      sessionId: 'bot:night-ops',
      agentProfileId: 'night-ops',
      ...overrides,
    },
  } as unknown as ToolUseContext;
}

/** Build one persisted message row (source-classified shape). */
function row(id: string, source: string, role = 'assistant'): Record<string, unknown> {
  return { id, source, role, msg_type: 'text' };
}

/** Build one previously-persisted reaction row. */
function reactionRow(targetId: string, emoji: string, by: string, set?: string[]): Record<string, unknown> {
  return {
    id: `reaction-${targetId}-${emoji}-${by}`,
    role: 'assistant',
    msg_type: 'reaction',
    source: 'reaction',
    metadata: { source: 'reaction', reaction: { targetId, emoji, by, ...(set ? { set } : {}) } },
  };
}

beforeEach(() => {
  fakeState.rows = [
    row('u1', 'user', 'user'),
    row('b1', 'send_message'),
    row('t1', 'tool_use'),
    row('think1', 'thinking'),
  ];
  fakeState.appended = [];
});

describe('resolveReactToMessage', () => {
  it('accepts messageId + emoji', () => {
    expect(resolveReactToMessage({ messageId: 'u1', emoji: '👍' })).toEqual({
      ok: true,
      messageId: 'u1',
      emoji: '👍',
    });
  });

  it('rejects a missing or empty emoji', () => {
    expect(resolveReactToMessage({ messageId: 'u1' }).ok).toBe(false);
    expect(resolveReactToMessage({ messageId: 'u1', emoji: '   ' }).ok).toBe(false);
  });

  it('rejects a missing messageId', () => {
    expect(resolveReactToMessage({ emoji: '👍' }).ok).toBe(false);
  });
});

describe('ReactToMessageTool.execute', () => {
  it('appends a reaction row targeting a user message', async () => {
    const result = await reactToMessageTool.execute(
      { messageId: 'u1', emoji: '🎉' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Reacted 🎉');
    expect(fakeState.appended).toHaveLength(1);
    const message = fakeState.appended[0].messages[0] as Record<string, unknown>;
    expect(fakeState.appended[0].sessionId).toBe('bot:night-ops');
    expect(message.msg_type).toBe('reaction');
    expect(message.source).toBe('reaction');
    expect((message.metadata as Record<string, unknown>).reaction).toMatchObject({
      targetId: 'u1',
      emoji: '🎉',
      by: 'night-ops',
    });
  });

  it('reacts to the bot own sends too', async () => {
    const result = await reactToMessageTool.execute(
      { messageId: 'b1', emoji: '👀' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBeUndefined();
  });

  it('toggles: a second identical reaction removes it (set shrinks)', async () => {
    fakeState.rows.push(reactionRow('u1', '👍', 'night-ops'));
    const result = await reactToMessageTool.execute(
      { messageId: 'u1', emoji: '👍' },
      undefined,
      makeContext(),
    );
    expect(result.result).toContain('Removed your 👍');
    const message = fakeState.appended[0].messages[0] as Record<string, unknown>;
    const reaction = (message.metadata as Record<string, unknown>).reaction as Record<string, unknown>;
    expect(reaction.set).toEqual([]);
  });

  it('keeps other emojis when toggling one off (set = remaining)', async () => {
    fakeState.rows.push(
      reactionRow('u1', '👍', 'night-ops'),
      reactionRow('u1', '🎉', 'night-ops'),
    );
    await reactToMessageTool.execute({ messageId: 'u1', emoji: '👍' }, undefined, makeContext());
    const message = fakeState.appended[0].messages[0] as Record<string, unknown>;
    const reaction = (message.metadata as Record<string, unknown>).reaction as Record<string, unknown>;
    expect(reaction.set).toEqual(['🎉']);
  });

  it('does not treat another agent reaction as its own (by is scoped)', async () => {
    fakeState.rows.push(reactionRow('u1', '👍', 'other-bot'));
    const result = await reactToMessageTool.execute(
      { messageId: 'u1', emoji: '👍' },
      undefined,
      makeContext(),
    );
    expect(result.result).toContain('Reacted 👍');
  });

  it('rejects targets that do not exist (NOT_FOUND)', async () => {
    const result = await reactToMessageTool.execute(
      { messageId: 'ghost', emoji: '👍' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result).error.code).toBe('NOT_FOUND');
  });

  it('rejects non-reactable targets (tool_use / thinking rows)', async () => {
    for (const id of ['t1', 'think1']) {
      const result = await reactToMessageTool.execute(
        { messageId: id, emoji: '👍' },
        undefined,
        makeContext(),
      );
      expect(JSON.parse(result.result).error.code).toBe('NOT_REACTABLE');
    }
  });

  it('accepts legacy rows without a source classifier (role-based)', async () => {
    fakeState.rows = [{ id: 'legacy1', role: 'user', msg_type: 'text' }];
    const result = await reactToMessageTool.execute(
      { messageId: 'legacy1', emoji: '❤️' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBeUndefined();
  });

  it('returns NO_SESSION without a session id', async () => {
    const result = await reactToMessageTool.execute(
      { messageId: 'u1', emoji: '👍' },
      undefined,
      makeContext({ sessionId: undefined }),
    );
    expect(JSON.parse(result.result).error.code).toBe('NO_SESSION');
  });

  it('surfaces bridge failures as BRIDGE_ERROR', async () => {
    const result = await reactToMessageTool.execute(
      { messageId: 'u1', emoji: '👍' },
      undefined,
      makeContext({ sessionId: '__bridge_error__' }),
    );
    expect(JSON.parse(result.result).error.code).toBe('BRIDGE_ERROR');
  });
});

describe('ReactToMessageTool surface', () => {
  it('exposes the grok-parity tool name and short-circuit permission', () => {
    expect(reactToMessageTool.name).toBe(REACT_TO_MESSAGE_TOOL_NAME);
    const verdict = reactToMessageTool.checkPermissions(
      {},
      {} as Parameters<typeof reactToMessageTool.checkPermissions>[1],
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiresUserConfirmation).toBeFalsy();
  });
});
