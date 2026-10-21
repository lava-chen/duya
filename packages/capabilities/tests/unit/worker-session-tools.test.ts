import { describe, expect, it, vi } from 'vitest';
import { decodeEnvelope } from '@duya/agent-protocol/agent-dm';
import { CreateAgentTool, UpdateAgentTool, type AgentManagementPort } from '../../src/agent-management-tool.js';
import { MessageSessionTool, type MessageSessionPort } from '../../src/message-session-tool.js';
import { PostToRoomTool, type PostToRoomPort } from '../../src/post-to-room-tool.js';
import { ReactToMessageTool, type ReactToMessagePort } from '../../src/react-to-message-tool.js';
import { SendToAgentTool, type SendToAgentPort } from '../../src/send-to-agent-tool.js';
import { SessionSearchTool, type SessionSearchPort } from '../../src/session-search-tool.js';
import { SessionTool, type SessionToolPort } from '../../src/session-tool.js';
import type { ToolUseContext } from '../../src/contracts/tool.js';
import type { WorkerEvent } from '@duya/agent-protocol/worker-protocol';

function context(sessionId = 'bot:sender'): ToolUseContext {
  return { toolUseId: 'tool-1', options: { sessionId } } as unknown as ToolUseContext;
}

describe('migrated worker tool capabilities', () => {
  it('delegates SessionSearch queries and recent browsing to its Host port', async () => {
    const port: SessionSearchPort = {
      searchSessions: vi.fn(async () => [{
        sessionId: 'prior-session', title: 'Prior chat', projectName: 'duya', source: 'cli', sessionStarted: 1_800_000_000,
        snippet: 'we fixed rail routing',
      }]),
      loadRecentSessionDirectory: vi.fn(async () => ({
        sameProject: [{ sessionId: 'recent', title: 'Recent', updatedAt: 1_800_000_000, childCount: 2 }],
        otherProjects: [],
      })),
      getMessages: vi.fn(async () => []),
      async *streamSummary() { yield 'We fixed the routing in the prior conversation.'; },
    };
    const tool = new SessionSearchTool(port);
    tool.configureSummaryLLM({ provider: 'openai', apiKey: 'test-key', model: 'test-model' });

    const searched = await tool.execute({ query: 'rail routing', scope: 'same_project' }, 'E:/duya', context('current'));
    expect(port.searchSessions).toHaveBeenCalledWith({
      query: 'rail routing', limit: 3, scope: 'same_project', workingDirectory: 'E:/duya', currentSessionId: 'current',
    });
    expect(searched.result).toContain('We fixed the routing');
    expect(searched.result).toContain('prior-session');

    const recent = await tool.execute({ scope: 'same_project', limit: 2 }, 'E:/duya', context('current'));
    expect(port.loadRecentSessionDirectory).toHaveBeenCalledWith({
      currentSessionId: 'current', workingDirectory: 'E:/duya', sameProjectLimit: 2, otherProjectLimit: 0,
    });
    expect(recent.result).toContain('Session ID: recent');
  });

  it('preserves Session action dispatch and the asynchronous spawn result contract', async () => {
    const port: SessionToolPort = {
      getCallerSessionId: (sessionId) => sessionId || 'fallback',
      spawn: vi.fn(async () => ({ ok: true, sessionId: 'child-1', parentId: 'parent-1' })),
      list: vi.fn(async () => ({ ok: true, sessions: [] })),
      get: vi.fn(async () => ({ ok: false, reason: 'missing' })),
      reply: vi.fn(async () => ({ ok: true, sessionId: 'child-1' })),
      cancel: vi.fn(async () => ({ ok: true, sessionId: 'child-1' })),
      rename: vi.fn(async () => ({ ok: true, sessionId: 'child-1' })),
    };
    const result = await new SessionTool(port).execute(
      { action: 'spawn', workingDirectory: 'E:/project', prompt: 'inspect the build' },
      undefined,
      context('parent-1'),
    );
    expect(port.spawn).toHaveBeenCalledWith({
      parentSessionId: 'parent-1', workingDirectory: 'E:/project', prompt: 'inspect the build',
    });
    expect(result.result).toContain('child-1');
    expect(result.result).toContain('do not poll');
  });

  it('keeps agent create and update result/error teaching behavior', async () => {
    const port: AgentManagementPort = {
      createAgent: vi.fn(async () => ({ id: 'agent-new', name: 'Researcher' })),
      updateAgent: vi.fn(async () => { throw new Error('agent not found'); }),
    };
    const created = await new CreateAgentTool(port).execute({ name: 'Researcher' });
    const updated = await new UpdateAgentTool(port).execute({ agentId: 'missing', name: 'New name' });
    expect(created.result).toContain('agent-new');
    expect(updated.result).toContain('No agent found with id missing');
    expect(updated.error).toBeUndefined();
  });

  it('formats MessageSession terminal output and target tool use summaries', async () => {
    const events = [
      { type: 'chat:text', content: 'answer' },
      { type: 'chat:tool_use', name: 'Read' },
    ] as unknown as WorkerEvent[];
    const port: MessageSessionPort = {
      getCallerSessionId: (sessionId) => sessionId || 'fallback',
      invoke: vi.fn(async (request) => ({
        kind: 'terminal',
        terminalEvent: { type: 'chat:done', sessionId: request.targetSessionId } as WorkerEvent,
        events,
      })),
    };
    const result = await new MessageSessionTool(port).execute(
      { targetSessionId: 'target', message: 'what changed?', mode: 'minimal' },
      undefined,
      context('caller'),
    );
    expect(port.invoke).toHaveBeenCalledWith(expect.objectContaining({
      callerSessionId: 'caller', targetSessionId: 'target', message: 'what changed?', mode: 'minimal', timeout: 60,
    }));
    expect(result.result).toBe('answer\n\n[Target agent used tools: Read]');
  });

  it('validates room membership, respects pass, and writes a room transcript entry', async () => {
    const appends: Array<{ sessionId: string; messages: Array<Record<string, unknown>> }> = [];
    const port: PostToRoomPort = {
      getSenderSessionId: (sessionId) => sessionId || 'bot:member',
      getSenderAgentId: () => 'member',
      isPassContent: (text) => text.trim() === '(pass)',
      listResolvedGroups: async () => ({ room: { id: 'room', name: 'Team', memberIds: ['member'] } }),
      validateRoomTarget: (roomId) => ({ roomId, sessionId: `room:${roomId}` }),
      readConfigAgents: async () => ({ member: { name: 'Member' } }),
      async appendMessages(sessionId, messages) { appends.push({ sessionId, messages }); },
    };
    const tool = new PostToRoomTool(port);
    const pass = await tool.execute({ roomId: 'room', text: '(pass)' }, undefined, context());
    const sent = await tool.execute({ roomId: 'room', text: 'The build is green.' }, undefined, context());
    expect(pass.result).toContain('room saw no message');
    expect(sent.result).toContain('Sent to Team');
    expect(appends).toHaveLength(1);
    expect(appends[0]?.sessionId).toBe('room:room');
    expect(appends[0]?.messages[0]).toMatchObject({ source: 'group', content: 'The build is green.' });
  });

  it('preserves SendToAgent envelope identity, mailbox nonce, and sender marker', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const markers: Array<{ sessionId: string; messages: Array<Record<string, unknown>> }> = [];
    const port: SendToAgentPort = {
      getSenderSessionId: (sessionId) => sessionId || 'bot:sender',
      readConfigAgents: async () => ({ sender: { name: 'Sender' }, target: { name: 'Target' } }),
      async sendMailbox(input) { sent.push(input); },
      async appendMessages(sessionId, messages) { markers.push({ sessionId, messages }); },
    };
    const result = await new SendToAgentTool(port).execute(
      { toAgentId: 'target', text: 'Please check this.', intent: 'request', replyToMessageId: 'msg-in' },
      undefined,
      context(),
    );
    const envelope = decodeEnvelope(sent[0]?.content as string);
    expect(result.result).toContain('Sent to Target');
    expect(envelope).toMatchObject({
      from: { id: 'bot:sender', name: 'Sender' },
      to: { id: 'target', name: 'Target' },
      clientMsgId: sent[0].clientMsgId,
      intent: 'request',
      replyTo: { messageId: 'msg-in' },
    });
    expect(sent[0]).toMatchObject({ kind: 'agent_dm', source: 'bot:sender', clientMsgId: envelope?.clientMsgId });
    expect(markers[0]?.sessionId).toBe('bot:sender');
    expect(markers[0]?.messages[0]).toMatchObject({ source: 'agent_dm' });
  });

  it('exercises the existing ReactToMessage executor through an injected Host port', async () => {
    const writes: unknown[] = [];
    const port: ReactToMessagePort = {
      resolveInvocationContext: () => ({ sessionId: 'session-1', actorId: 'agent-1' }),
      getTranscript: async () => [{ id: 'user-msg', role: 'user', source: 'user' }],
      async appendReaction(input) { writes.push(input); },
    };
    const result = await new ReactToMessageTool(port).execute({ messageId: 'user-msg', emoji: '👍' });
    expect(result.result).toContain('Reacted 👍');
    expect(writes).toEqual([{ sessionId: 'session-1', targetId: 'user-msg', emoji: '👍', by: 'agent-1', set: ['👍'] }]);
  });
});
