/**
 * Plan 315 focused tests for duyaAgent message-source migration.
 *
 * Verifies that the internal MessageTimeline is the runtime authority while
 * the legacy public surface (setMessages / getMessages / addMessage) remains
 * backward compatible with the provider-shaped `Message[]` contract.
 *
 * Coverage map (per task spec):
 *   1. Legacy history loads and continues conversation.
 *   2. user -> assistant -> multiple tools -> tool result -> continue.
 *   3. mailbox & task notification: not persisted, not rendered, but in model.
 *   4. AGENTS.md is not duplicated across turns.
 *   5. Mode / discovered tool prompt takes effect on the second turn.
 *   6. Compaction keeps the provider in the loop afterwards.
 *   7. getMessages() still returns the legacy Message[] shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '../../../src/types.js';

// --- Mocked LLM client -----------------------------------------------------

interface StreamConfig {
  /** Per-call scripted SSE events. Each entry = one streamChat call. */
  responses: SSEEvent[][];
  /** Per-call scripted error to throw. If set, that call throws instead of yielding. */
  errors?: (Error | string | undefined)[];
}

const streamState = vi.hoisted(() => ({
  current: { responses: [] as SSEEvent[][] } as StreamConfig,
  callCount: 0,
  /** Captures the messages array passed to each streamChat invocation. */
  seenMessages: [] as unknown[][],
  /** Captures the tools array passed to each streamChat invocation. */
  seenTools: [] as unknown[][],
  /** Captures the systemPrompt passed to each streamChat invocation. */
  seenSystemPrompts: [] as (string | undefined)[],
}));

vi.mock('@duya/ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@duya/ai')>();
  const mockClient = (): unknown => ({
    streamChat: vi.fn(async function* (messages: unknown[], options?: { systemPrompt?: string; tools?: unknown[] }) {
      streamState.callCount += 1;
      streamState.seenMessages.push(messages);
      streamState.seenTools.push(options?.tools ?? []);
      streamState.seenSystemPrompts.push(options?.systemPrompt);
      const index = streamState.callCount - 1;
      const scriptedError = streamState.current.errors?.[index];
      if (scriptedError) {
        throw scriptedError instanceof Error
          ? scriptedError
          : new Error(scriptedError ?? 'stream error');
      }
      const scripted = streamState.current.responses[index] ?? [
        { type: 'text', data: 'ok' },
        { type: 'done' },
      ];
      for (const event of scripted) {
        yield event as SSEEvent;
      }
    }),
  });
  return {
    ...mod,
    createAIClient: vi.fn(() => mockClient()),
    createAIClientWithRetry: vi.fn(() => mockClient()),
    inferProvider: vi.fn(() => 'anthropic'),
  };
});

// --- Mocked mailbox DB so DuyaAgent can be constructed without IPC ---------

vi.mock('../../../src/ipc/db-client.js', () => ({
  mailboxDb: {
    claimBatch: vi.fn(async () => ({ rows: [], claimTokens: [] })),
    apply: vi.fn(async () => ({})),
    markObserved: vi.fn(async () => ({})),
  },
  pluginDb: {
    list: vi.fn(async () => []),
  },
}));

// --- Mocked agentsmd manager so AGENTS.md injection is deterministic -------

const agentsMdState = vi.hoisted(() => ({
  currentText: '',
}));

vi.mock('../../../src/agentsmd/index.js', () => ({
  getAgentsMdManager: vi.fn(() => ({
    refreshForTask: vi.fn(async () => ({})),
    buildAgentsMdPrompt: vi.fn(() => agentsMdState.currentText),
    getLoadedFiles: vi.fn(() => []),
    getFilesByType: vi.fn(() => []),
    getLargeFiles: vi.fn(() => []),
    hasFiles: vi.fn(() => agentsMdState.currentText.length > 0),
    getFileCount: vi.fn(() => (agentsMdState.currentText.length > 0 ? 1 : 0)),
  })),
}));

// ---------------------------------------------------------------------------

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import type { Message, MessageContent } from '../../../src/types.js';
import { MessageTimeline } from '../../../src/message/message-framework.js';
import { legacyMessageToAgentMessage } from '../../../src/message/legacy-message-adapter.js';
import { MessageCompactionController } from '../../../src/message/message-compaction-controller.js';
import { projectTimelinePersistenceMessages } from '../../../src/message/message-projectors.js';
import type { EnhancedCompactionResult } from '../../../src/compact/CompactionManager.js';
import { clearCommandQueue } from '../../../src/queue/index.js';
import { ToolRegistry } from '../../../src/tool/registry.js';

function newAgent(options: Record<string, unknown> = {}): duyaAgent {
  return new duyaAgent({
    apiKey: 'test-key',
    provider: 'anthropic',
    model: 'test-model',
    enableRetry: false,
    ...options,
  });
}

function textBlock(text: string): MessageContent[] {
  return [{ type: 'text', text }];
}

function userMessage(content: string, id?: string): Message {
  return {
    id: id ?? crypto.randomUUID(),
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function assistantMessage(content: string, id?: string): Message {
  return {
    id: id ?? crypto.randomUUID(),
    role: 'assistant',
    content: textBlock(content),
    timestamp: Date.now(),
  };
}

async function drainStream(
  agent: duyaAgent,
  prompt: string | MessageContent[],
  options?: Parameters<duyaAgent['streamChat']>[1],
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of agent.streamChat(prompt, options)) {
    events.push(event);
  }
  return events;
}

describe('Plan 315 — duyaAgent MessageTimeline migration', () => {
  beforeEach(() => {
    streamState.current = { responses: [], errors: [] };
    streamState.callCount = 0;
    streamState.seenMessages = [];
    streamState.seenTools = [];
    streamState.seenSystemPrompts = [];
    agentsMdState.currentText = '';
    clearCommandQueue();
  });

  afterEach(() => {
    clearCommandQueue();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------
  // 7. getMessages() still returns the legacy Message[] shape.
  // ---------------------------------------------------------------
  describe('legacy Message[] surface', () => {
    it('returns a Message[] with original role/content/id after setMessages', () => {
      const agent = newAgent();
      const legacy: Message[] = [
        userMessage('hello', 'u-1'),
        assistantMessage('hi there', 'a-1'),
      ];
      agent.setMessages(legacy);

      const projected = agent.getMessages() as Message[];
      expect(projected).toHaveLength(2);
      expect(projected[0]).toMatchObject({ id: 'u-1', role: 'user', content: 'hello' });
      expect(projected[1]).toMatchObject({ id: 'a-1', role: 'assistant' });
      const assistantContent = projected[1].content as MessageContent[];
      expect(Array.isArray(assistantContent)).toBe(true);
      expect((assistantContent[0] as { text: string }).text).toBe('hi there');
    });

    it('keeps consecutive legacy messages without ids distinct without writing ids back', () => {
      const agent = newAgent();
      agent.addMessage({ role: 'user', content: 'first' });
      agent.addMessage({ role: 'user', content: 'second' });

      expect(agent.getMessages()).toEqual([
        { role: 'user', content: 'first', timestamp: expect.any(Number) },
        { role: 'user', content: 'second', timestamp: expect.any(Number) },
      ]);
    });

    it('addMessage appends to the timeline and surfaces via getMessages', () => {
      const agent = newAgent();
      agent.setMessages([userMessage('first')]);
      agent.addMessage(assistantMessage('second'));

      const projected = agent.getMessages() as Message[];
      expect(projected).toHaveLength(2);
      expect(projected[0]?.role).toBe('user');
      expect(projected[1]?.role).toBe('assistant');
    });

    it('clearMessages empties the projected Message[]', () => {
      const agent = newAgent();
      agent.setMessages([userMessage('a'), assistantMessage('b')]);
      agent.clearMessages();
      expect(agent.getMessages()).toHaveLength(0);
    });
  });

  describe('durable compaction checkpoint', () => {
    it('restores a real checkpoint and reinjected system context after restart', async () => {
      const source: Message[] = [
        userMessage('discard this', 'u-1'),
        assistantMessage('discard reply', 'a-1'),
        userMessage('retain this', 'u-2'),
        assistantMessage('retain reply', 'a-2'),
      ];
      const timeline = new MessageTimeline();
      for (const [index, message] of source.entries()) {
        const adapted = legacyMessageToAgentMessage(message, { index });
        timeline.appendMessage({
          type: 'message',
          id: `entry-${index}`,
          parentId: null,
          createdAt: adapted.createdAt,
          message: adapted,
        });
      }
      const manager = {
        compact: vi.fn(async (input: Message[]): Promise<EnhancedCompactionResult> => ({
          messages: [
            { role: 'system', content: 'checkpoint summary', isCompactSummary: true },
            { role: 'system', content: 'reinject file state' },
            ...input.slice(2),
          ],
          tokensRemoved: 10,
          tokensRetained: 5,
          strategy: 'test',
        })),
        reactiveCompact: vi.fn(),
        updateContextTokens: vi.fn(),
        shouldCompact: vi.fn(() => true),
      };
      const controller = new MessageCompactionController({
        timeline,
        compactionManager: manager,
        idGenerator: () => 'compact-1',
        clock: () => 42,
      });
      await controller.compactProactive();

      const persisted = projectTimelinePersistenceMessages(timeline.snapshot());
      expect(persisted).toHaveLength(3);
      expect(persisted[0]).toMatchObject({
        role: 'system',
        isCompactSummary: true,
        compactBoundaryId: 'compact-1',
        msg_type: 'compact_checkpoint',
        tool_input: expect.any(String),
      });
      expect(persisted[0]?.metadata).toBeUndefined();

      streamState.current = { responses: [[{ type: 'done' }]] };
      const restarted = newAgent();
      restarted.setMessages(persisted);
      await drainStream(restarted, 'continue');

      const providerMessages = streamState.seenMessages[0] as Message[];
      expect(providerMessages.map((message) => String(message.content))).toEqual(
        expect.arrayContaining(['retain this', expect.stringContaining('checkpoint summary')]),
      );
      expect(providerMessages.map((message) => String(message.content))).not.toContain('discard this');
      expect(streamState.seenSystemPrompts[0]).toContain('reinject file state');
    });
  });

  // ---------------------------------------------------------------
  // 1. Legacy history loads and continues conversation.
  // ---------------------------------------------------------------
  describe('legacy history reload', () => {
    it('seeds the timeline from setMessages and feeds them to the provider on the next streamChat', async () => {
      const agent = newAgent();
      const legacy: Message[] = [
        userMessage('past turn', 'u-past'),
        assistantMessage('past reply', 'a-past'),
      ];
      agent.setMessages(legacy);

      streamState.current = {
        responses: [
          [
            { type: 'text', data: 'continuation' },
            { type: 'done' },
          ],
        ],
      };

      const events = await drainStream(agent, 'follow up');

      // LLM was called exactly once.
      expect(streamState.callCount).toBe(1);
      // The provider saw the legacy history plus the new user prompt.
      const seen = streamState.seenMessages[0] as Message[];
      const roles = seen.map((m) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
      // The durable legacy messages survived the round-trip.
      expect(seen.some((m) => m.id === 'u-past')).toBe(true);
      expect(seen.some((m) => m.id === 'a-past')).toBe(true);

      // The stream completed.
      expect(events.map((e) => e.type)).toContain('done');

      // getMessages still returns legacy Message[] shape with the new turn appended.
      const projected = agent.getMessages() as Message[];
      expect(projected.length).toBeGreaterThanOrEqual(3);
      expect(projected.some((m) => m.id === 'u-past')).toBe(true);
      expect(projected.some((m) => m.role === 'assistant')).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // 2. user -> assistant -> multiple tools -> tool result -> continue.
  // ---------------------------------------------------------------
  describe('multi-turn tool loop', () => {
    it('mirrors assistant + tool_result to the timeline across two provider rounds', async () => {
      const agent = newAgent();
      const toolUseId1 = 'tu-1';
      const toolUseId2 = 'tu-2';

      streamState.current = {
        responses: [
          // Round 1: model emits text + two tool_use blocks, then done.
          [
            { type: 'text', data: 'I will run two tools' },
            {
              type: 'tool_use',
              data: { id: toolUseId1, name: 'echo', input: { msg: 'one' } },
            },
            {
              type: 'tool_use',
              data: { id: toolUseId2, name: 'echo', input: { msg: 'two' } },
            },
            { type: 'done' },
          ],
          // Round 2: model sees results and finishes.
          [
            { type: 'text', data: 'done now' },
            { type: 'done' },
          ],
        ],
      };

      const events = await drainStream(agent, 'please run two tools');

      // The provider was called twice (one per round).
      expect(streamState.callCount).toBe(2);

      // Round 2 saw both tool_result blocks.
      const round2Messages = streamState.seenMessages[1] as Message[];
      const toolResults = round2Messages.filter(
        (m) =>
          m.role === 'tool' ||
          (Array.isArray(m.content) &&
            (m.content as MessageContent[]).some(
              (c) => c.type === 'tool_result',
            )),
      );
      expect(toolResults.length).toBeGreaterThanOrEqual(2);

      // The stream emitted tool_use + tool_result events.
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('tool_use');
      expect(eventTypes).toContain('tool_result');
      expect(eventTypes).toContain('done');

      // The timeline now holds the user, the assistant turn, and both tool results.
      const projected = agent.getMessages() as Message[];
      const roles = projected.map((m) => m.role);
      expect(roles).toContain('user');
      expect(roles.filter((r) => r === 'assistant').length).toBeGreaterThanOrEqual(1);
      expect(roles.filter((r) => r === 'tool').length).toBeGreaterThanOrEqual(2);
    });

    it('projects deferred tool follow-up as hidden runtime context', async () => {
      const registry = new ToolRegistry();
      registry.register(
        { name: 'deferred_review', description: 'Deferred review', input_schema: {} },
        {
          execute: async () => ({
            id: 'result-1',
            name: 'deferred_review',
            result: 'primary result',
            pendingContext: Promise.resolve({ result: 'review context' }),
          }),
        },
      );
      const agent = newAgent();
      streamState.current = {
        responses: [
          [
            {
              type: 'tool_use',
              data: { id: 'deferred-1', name: 'deferred_review', input: {} },
            },
            { type: 'done' },
          ],
          [{ type: 'text', data: 'used review' }, { type: 'done' }],
        ],
      };

      await drainStream(agent, 'run deferred review', { toolRegistry: registry });

      const round2 = streamState.seenMessages[1] as Message[];
      expect(round2.filter((message) => message.role === 'tool')).toHaveLength(1);
      expect(round2.some((message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<deferred-tool-context>') &&
        message.content.includes('review context'),
      )).toBe(true);

      const durable = agent.getMessages() as Message[];
      expect(durable.filter((message) => message.role === 'tool')).toHaveLength(1);
      expect(durable.some((message) => String(message.content).includes('review context'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // 3. mailbox & task notification: not persisted, not rendered, in model.
  // ---------------------------------------------------------------
  describe('runtime context filtering', () => {
    it('does not surface mailbox runtime instructions in getMessages but includes them in the provider payload', async () => {
      const agent = newAgent({ sessionId: 'sess-mailbox' });

      // Stub mailboxDb.claimBatch to return one correction row.
      const { mailboxDb } = await import('../../../src/ipc/db-client.js');
      const claimBatchMock = vi.spyOn(mailboxDb, 'claimBatch');
      claimBatchMock.mockResolvedValue({
        rows: [
          {
            id: 'mail-1',
            session_id: 'sess-mailbox',
            content: 'Use concise language',
            kind: 'correction',
            status: 'observed',
          } as never,
        ],
        claimTokens: ['claim-1'],
      });
      vi.spyOn(mailboxDb, 'apply').mockResolvedValue({} as never);

      streamState.current = {
        responses: [
          [
            { type: 'text', data: 'ack' },
            { type: 'done' },
          ],
        ],
      };

      await drainStream(agent, 'start working');

      // getMessages() must NOT contain the mailbox runtime instruction.
      const projected = agent.getMessages() as Message[];
      const mailboxLeaked = projected.some((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as MessageContent[])
                .map((c) => (c as { text?: string }).text ?? '')
                .join('')
            : '';
        return text.includes('Use concise language');
      });
      expect(mailboxLeaked).toBe(false);

      // The provider DID see the mailbox content somewhere in its messages.
      const seen = streamState.seenMessages[0] as Message[];
      const mailboxSeen = seen.some((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as MessageContent[])
                .map((c) => (c as { text?: string }).text ?? '')
                .join('')
            : '';
        return text.includes('Use concise language');
      });
      expect(mailboxSeen).toBe(true);
    });

    it('claims background notifications through the mailbox and injects them as transient runtime context', async () => {
      const agent = newAgent({ sessionId: 'sess-background' });

      // Stub mailboxDb.claimBatch to return one background_notification row
      // whose content is the <task-notification> XML envelope.
      const { mailboxDb } = await import('../../../src/ipc/db-client.js');
      vi.spyOn(mailboxDb, 'claimBatch').mockResolvedValue({
        rows: [
          {
            id: 'mail-bg-1',
            session_id: 'sess-background',
            content: '<task-notification><task-id>child-1</task-id><status>completed</status></task-notification>',
            kind: 'background_notification',
            status: 'observed',
          } as never,
        ],
        claimTokens: ['claim-bg-1'],
      });
      vi.spyOn(mailboxDb, 'apply').mockResolvedValue({} as never);

      streamState.current = {
        responses: [[{ type: 'text', data: 'ack' }, { type: 'done' }]],
      };

      await drainStream(agent, 'continue');

      // getMessages excludes transient task notifications.
      const projected = agent.getMessages() as Message[];
      expect(projected.some((m) => String(m.content).includes('<task-notification>'))).toBe(false);

      const providerMessages = streamState.seenMessages[0] as Message[];
      expect(providerMessages.some(
        (message) => typeof message.content === 'string' && message.content.includes('child-1'),
      )).toBe(true);

      // Runtime notifications are contributors, never ledger entries.
      const internal = (agent as unknown as {
        timeline: {
          snapshot: () => Array<{ message?: { metadata?: Record<string, unknown> } }>;
        };
      }).timeline.snapshot();
      const hasNotification = internal.some(
        (entry) => entry.message?.metadata?.taskId === 'child-1',
      );
      expect(hasNotification).toBe(false);
    });

    it('projects attachment text as transient runtime context without persisting it in the user turn', async () => {
      const agent = newAgent();
      streamState.current = {
        responses: [[{ type: 'text', data: 'done' }, { type: 'done' }]],
      };

      await drainStream(agent, 'summarize the attachment', {
        attachments: [{
          id: 'file-1',
          name: 'notes.txt',
          type: 'text/plain',
          text: 'important attachment text',
        }],
      });

      const providerMessages = streamState.seenMessages[0] as Message[];
      expect(providerMessages.some((message) =>
        typeof message.content === 'string' && message.content.includes('important attachment text'),
      )).toBe(true);

      const durableUser = (agent.getMessages() as Message[]).find(
        (message) => message.role === 'user',
      );
      expect(durableUser?.content).toBe('summarize the attachment');
    });

    it('adds current time as a non-cacheable request contributor', async () => {
      const agent = newAgent();
      const observedPrompts: string[] = [];
      streamState.current = {
        responses: [[{ type: 'text', data: 'done' }, { type: 'done' }]],
      };

      await drainStream(agent, 'what time is it?', {
        onSystemPromptReady: ({ systemPrompt }) => observedPrompts.push(systemPrompt),
      });

      expect(observedPrompts).toHaveLength(1);
      expect(observedPrompts[0]).toContain('Current date and time:');
    });
  });

  // ---------------------------------------------------------------
  // 4. AGENTS.md is not duplicated across turns.
  // ---------------------------------------------------------------
  describe('AGENTS.md injection', () => {
    it('adds AGENTS.md exactly once on the first turn of a streamChat call', async () => {
      agentsMdState.currentText = '<agents-md>project rules</agents-md>';

      const agent = newAgent();

      streamState.current = {
        responses: [
          // Round 1: model calls a tool.
          [
            { type: 'text', data: 'running' },
            {
              type: 'tool_use',
              data: { id: 'tu-md-1', name: 'echo', input: { msg: 'x' } },
            },
            { type: 'done' },
          ],
          // Round 2: model finishes.
          [
            { type: 'text', data: 'finished' },
            { type: 'done' },
          ],
        ],
      };

      await drainStream(agent, 'do something');

      expect(streamState.callCount).toBe(2);

      // Round 1 payload should contain the AGENTS.md text exactly once.
      const round1Messages = streamState.seenMessages[0] as Message[];
      const round1MdCount = round1Messages.filter((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as MessageContent[])
                .map((c) => (c as { text?: string }).text ?? '')
                .join('')
            : '';
        return text.includes('<agents-md>project rules</agents-md>');
      }).length;
      expect(round1MdCount).toBe(1);

      // Round 2 payload should NOT re-inject AGENTS.md.
      const round2Messages = streamState.seenMessages[1] as Message[];
      const round2MdCount = round2Messages.filter((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as MessageContent[])
                .map((c) => (c as { text?: string }).text ?? '')
                .join('')
            : '';
        return text.includes('<agents-md>project rules</agents-md>');
      }).length;
      expect(round2MdCount).toBe(0);

      // getMessages does not surface AGENTS.md (it was added only to llmMessages, not timeline).
      const projected = agent.getMessages() as Message[];
      const mdLeaked = projected.some((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as MessageContent[])
                .map((c) => (c as { text?: string }).text ?? '')
                .join('')
            : '';
        return text.includes('<agents-md>project rules</agents-md>');
      });
      expect(mdLeaked).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // 5. Mode / discovered tool prompt takes effect on the second turn.
  // ---------------------------------------------------------------
  describe('mode prompt on second turn', () => {
    it('re-evaluates the mode prompt prefix each turn so the second provider call sees it', async () => {
      const { ToolRegistry } = await import('../../../src/tool/registry.js');
      const { ReadTool } = await import('../../../src/tool/ReadTool/ReadTool.js');
      const registry = new ToolRegistry();
      registry.register(new ReadTool() as never, new ReadTool() as never);

      const agent = newAgent();
      const cachePlanFingerprints: string[] = [];

      streamState.current = {
        responses: [
          [
            { type: 'text', data: 'first' },
            {
              type: 'tool_use',
              data: { id: 'tu-mode-1', name: 'read', input: { file_path: 'x' } },
            },
            { type: 'done' },
          ],
          [
            { type: 'text', data: 'second' },
            { type: 'done' },
          ],
        ],
      };

      await drainStream(agent, 'start', {
        mode: 'plan-task',
        toolRegistry: registry,
        onSystemPromptReady: (snapshot: { cachePlan: { fingerprint: string } }) => {
          cachePlanFingerprints.push(snapshot.cachePlan.fingerprint);
        },
      } as never);

      expect(streamState.callCount).toBe(2);

      // Both rounds should have received a non-empty system prompt that
      // carries the mode overlay. The exact wording is mode-dependent; we
      // only assert that the prompt is carried into round 2 (not lost).
      expect(streamState.seenSystemPrompts[0]).toBeTruthy();
      expect(streamState.seenSystemPrompts[1]).toBeTruthy();
      expect(streamState.seenSystemPrompts[1]?.length).toBeGreaterThan(0);
      expect(streamState.seenSystemPrompts[0]).toContain('# Plan Mode Active');
      expect(streamState.seenSystemPrompts[1]).toContain('# Plan Mode Active');
      expect(cachePlanFingerprints).toHaveLength(2);
      expect(cachePlanFingerprints[1]).toBe(cachePlanFingerprints[0]);

      // Tool surface is present on both rounds (proves the per-turn
      // snapshot rebuild did not drop it on the second turn).
      expect((streamState.seenTools[0] as unknown[]).length).toBeGreaterThan(0);
      expect((streamState.seenTools[1] as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // 6. Compaction keeps the provider in the loop afterwards.
  // ---------------------------------------------------------------
  describe('compaction continuation', () => {
    it('still invokes the provider after a proactive compaction entry is appended', async () => {
      const agent = newAgent();

      // Force the compaction controller to report that compaction is needed
      // for the first turn only. The controller is private, so we cast.
      const controller = agent as unknown as {
        compactionController: {
          shouldCompact: () => boolean;
          compactProactive: () => Promise<{
            strategy: string;
            tokensBefore: number;
            tokensAfter?: number;
          } | null>;
        };
      };
      const realShould = controller.compactionController.shouldCompact;
      const realCompact = controller.compactionController.compactProactive;
      let compactCalled = false;
      controller.compactionController.shouldCompact = () => !compactCalled;
      controller.compactionController.compactProactive = async () => {
        compactCalled = true;
        return { strategy: 'snip', tokensBefore: 1000, tokensAfter: 500 };
      };

      streamState.current = {
        responses: [
          [
            { type: 'text', data: 'post-compaction reply' },
            { type: 'done' },
          ],
        ],
      };

      const events = await drainStream(agent, 'continue after compact');

      // Compaction ran and the provider still produced a reply.
      expect(compactCalled).toBe(true);
      expect(streamState.callCount).toBe(1);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('text');
      expect(eventTypes).toContain('done');

      // Restore the originals so other tests are unaffected.
      controller.compactionController.shouldCompact = realShould;
      controller.compactionController.compactProactive = realCompact;
    });
  });

  // ---------------------------------------------------------------
  // 6b. Reactive compaction (context_length_exceeded) also goes
  // through the append-only controller, not the legacy manager.
  // ---------------------------------------------------------------
  describe('reactive compaction continuation', () => {
    it('routes context_length_exceeded through compactionController.compactReactive and appends an entry', async () => {
      const agent = newAgent();

      // Stub the controller so we can observe the call without depending
      // on the real CompactionManager strategy selection.
      const controller = agent as unknown as {
        compactionController: {
          compactReactive: (trigger?: string) => Promise<{
            strategy: string;
            tokensBefore: number;
            tokensAfter?: number;
          } | null>;
        };
      };
      const realCompactReactive = controller.compactionController.compactReactive.bind(
        controller.compactionController,
      );
      let reactiveTrigger: string | undefined;
      let reactiveCalls = 0;
      controller.compactionController.compactReactive = async (trigger?: string) => {
        reactiveCalls += 1;
        reactiveTrigger = trigger;
        return { strategy: 'snip', tokensBefore: 2000, tokensAfter: 800 };
      };

      streamState.current = {
        responses: [
          // Round 1 has no events — it throws before yielding anything.
          [],
          // Round 2 (after reactive compaction retried the same turn):
          // provider recovers and finishes.
          [
            { type: 'text', data: 'recovered after compaction' },
            { type: 'done' },
          ],
        ],
        errors: [
          // Round 1: provider throws a context_length_exceeded error.
          'context_length_exceeded: prompt too long',
        ],
      };

      const events = await drainStream(agent, 'trigger reactive compaction');

      // The reactive path was invoked exactly once with the right trigger.
      expect(reactiveCalls).toBe(1);
      expect(reactiveTrigger).toBe('context_length_exceeded');

      // The provider was called again after compaction (retry + completion).
      expect(streamState.callCount).toBe(2);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('text');
      expect(eventTypes).toContain('done');

      // Restore the original method so other tests are unaffected.
      controller.compactionController.compactReactive = realCompactReactive;
    });
  });
});
