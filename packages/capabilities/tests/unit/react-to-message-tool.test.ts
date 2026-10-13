import { describe, expect, it } from 'vitest';
import {
  ReactToMessageTool,
  resolveReactToMessage,
} from '../../src/ReactToMessageTool/ReactToMessageTool.js';
import type {
  AppendReactionInput,
  ReactToMessagePort,
  ReactToMessageTranscriptRow,
} from '../../src/ReactToMessageTool/ports.js';
import type { ToolContext, ToolUseContext } from '../../src/contracts/tool.js';

function createPort(initialRows: ReactToMessageTranscriptRow[] = []) {
  const rows = [...initialRows];
  const appends: AppendReactionInput[] = [];
  const port: ReactToMessagePort = {
    resolveInvocationContext(context) {
      if (!context || typeof context !== 'object') return {};
      const options = (context as { options?: unknown }).options;
      if (!options || typeof options !== 'object') return {};
      const values = options as Record<string, unknown>;
      return {
        sessionId: typeof values.sessionId === 'string' ? values.sessionId : undefined,
        actorId: typeof values.agentProfileId === 'string' ? values.agentProfileId : undefined,
      };
    },
    async getTranscript() {
      return rows;
    },
    async appendReaction(input) {
      appends.push(input);
      rows.push({
        id: `reaction-${appends.length}`,
        role: 'assistant',
        msg_type: 'reaction',
        source: 'reaction',
        metadata: {
          source: 'reaction',
          reaction: {
            targetId: input.targetId,
            emoji: input.emoji,
            by: input.by,
            set: input.set,
          },
        },
      });
    },
  };
  return { port, rows, appends };
}

function runContext(sessionId = 'session-1', agentProfileId?: string) {
  return { toolUseId: 'tool-1', options: { sessionId, agentProfileId } } as unknown as ToolUseContext;
}

function failureCode(result: { result: string }): string | undefined {
  const parsed: unknown = JSON.parse(result.result);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

describe('ReactToMessageTool capability', () => {
  it('keeps the public input, schema, tool name, and pre-approved permission contract', () => {
    const { port } = createPort();
    const tool = new ReactToMessageTool(port);

    expect(tool.name).toBe('ReactToMessage');
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      required: ['messageId', 'emoji'],
    });
    expect(tool.checkPermissions({}, undefined as unknown as ToolContext)).toEqual({
      allowed: true,
      reason: 'Emoji tapback (self-scoped, pre-approved).',
    });
    expect(resolveReactToMessage({ messageId: ' m1 ', emoji: ' 👍 ' })).toEqual({
      ok: true,
      messageId: 'm1',
      emoji: '👍',
    });
  });

  it('writes actor-scoped reaction snapshots and toggles the same emoji off', async () => {
    const { port, appends } = createPort([
      { id: 'm1', role: 'user', source: 'user' },
      {
        id: 'old-reaction',
        role: 'assistant',
        source: 'reaction',
        metadata: { reaction: { targetId: 'm1', emoji: '❤️', by: 'agent-a', set: ['❤️'] } },
      },
    ]);
    const tool = new ReactToMessageTool(port);

    const added = await tool.execute({ messageId: 'm1', emoji: '🔥' }, undefined, runContext('session-1', 'agent-a'));
    const removed = await tool.execute({ messageId: 'm1', emoji: '🔥' }, undefined, runContext('session-1', 'agent-a'));

    expect(added.result).toContain('Reacted 🔥');
    expect(removed.result).toContain('Removed your 🔥');
    expect(appends).toEqual([
      { sessionId: 'session-1', targetId: 'm1', emoji: '🔥', by: 'agent-a', set: ['❤️', '🔥'] },
      { sessionId: 'session-1', targetId: 'm1', emoji: '🔥', by: 'agent-a', set: ['❤️'] },
    ]);
  });

  it('accepts visible legacy assistant rows and rejects missing or non-visible targets', async () => {
    const { port } = createPort([{ id: 'legacy-assistant', role: 'assistant' }]);
    const tool = new ReactToMessageTool(port);

    const accepted = await tool.execute(
      { messageId: 'legacy-assistant', emoji: '👍' },
      undefined,
      runContext(),
    );
    expect(accepted.error).toBeUndefined();

    const missing = await tool.execute({ messageId: 'absent', emoji: '👍' }, undefined, runContext());
    expect(failureCode(missing)).toBe('NOT_FOUND');

    const nonVisible = createPort([{ id: 'tool-row', role: 'tool', source: 'tool' }]);
    const rejected = await new ReactToMessageTool(nonVisible.port).execute(
      { messageId: 'tool-row', emoji: '👍' },
      undefined,
      runContext(),
    );
    expect(failureCode(rejected)).toBe('NOT_REACTABLE');
    expect(nonVisible.appends).toHaveLength(0);
  });

  it('reports missing session and transcript or append failures with stable error codes', async () => {
    const noSession = createPort();
    const missingSession = await new ReactToMessageTool(noSession.port).execute(
      { messageId: 'm1', emoji: '👍' },
      undefined,
      runContext(''),
    );
    expect(failureCode(missingSession)).toBe('NO_SESSION');

    const brokenTranscript: ReactToMessagePort = {
      ...noSession.port,
      async getTranscript() {
        throw new Error('read failed');
      },
    };
    const readFailure = await new ReactToMessageTool(brokenTranscript).execute(
      { messageId: 'm1', emoji: '👍' },
      undefined,
      runContext(),
    );
    expect(failureCode(readFailure)).toBe('BRIDGE_ERROR');

    const brokenAppend: ReactToMessagePort = {
      ...createPort([{ id: 'm1', role: 'user', source: 'user' }]).port,
      async appendReaction() {
        throw new Error('append failed');
      },
    };
    const appendFailure = await new ReactToMessageTool(brokenAppend).execute(
      { messageId: 'm1', emoji: '👍' },
      undefined,
      runContext(),
    );
    expect(failureCode(appendFailure)).toBe('BRIDGE_ERROR');
    expect(JSON.parse(appendFailure.result)).toMatchObject({
      success: false,
      error: { message: 'append failed' },
    });
  });
});
