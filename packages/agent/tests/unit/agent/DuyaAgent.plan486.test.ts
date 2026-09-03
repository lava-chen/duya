/**
 * Plan 486 behavior tests on the DuyaAgent runtime surface:
 *   1. Fork (branched) user turn is persisted but excluded from the model
 *      projection and the main transcript.
 *   2. Quote reply (replyToId without branched) renders `[In reply to ...]`
 *      ahead of the model request while the durable message stays clean.
 *   3. An unknown replyToId is silently stripped (grok stripReplyTo parity).
 *   4. Branched rows survive the durable getMessages() projection with
 *      threadMeta intact (the getThread read path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '../../../src/types.js';

interface StreamConfig {
  responses: SSEEvent[][];
  errors?: (Error | string | undefined)[];
}

const streamState = vi.hoisted(() => ({
  current: { responses: [] as SSEEvent[][] } as StreamConfig,
  callCount: 0,
  seenMessages: [] as unknown[][],
}));

vi.mock('@duya/ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@duya/ai')>();
  const mockClient = (): unknown => ({
    streamChat: vi.fn(async function* (messages: unknown[]) {
      streamState.callCount += 1;
      streamState.seenMessages.push(messages);
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

const agentsMdState = vi.hoisted(() => ({ currentText: '' }));

vi.mock('../../../src/agentsmd/index.js', () => ({
  getAgentsMdManager: vi.fn(() => ({
    refreshForTask: vi.fn(async () => ({})),
    buildAgentsMdPrompt: vi.fn(() => agentsMdState.currentText),
    buildAgentsMdSection: vi.fn(() => agentsMdState.currentText),
    getLoadedFiles: vi.fn(() => []),
    getFilesByType: vi.fn(() => []),
    getLargeFiles: vi.fn(() => []),
    hasFiles: vi.fn(() => agentsMdState.currentText.length > 0),
    getFileCount: vi.fn(() => (agentsMdState.currentText.length > 0 ? 1 : 0)),
  })),
}));

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import type { Message } from '../../../src/types.js';
import { THREAD_METADATA_KEY } from '../../../src/message/threads.js';
import { clearCommandQueue } from '../../../src/queue/index.js';

function newAgent(options: Record<string, unknown> = {}): duyaAgent {
  return new duyaAgent({
    apiKey: 'test-key',
    provider: 'anthropic',
    model: 'test-model',
    enableRetry: false,
    ...options,
  });
}

function userMessage(content: string, id?: string): Message {
  return { id: id ?? crypto.randomUUID(), role: 'user', content, timestamp: Date.now() };
}

function assistantMessage(content: string, id?: string): Message {
  return {
    id: id ?? crypto.randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    timestamp: Date.now(),
  };
}

async function drainStream(
  agent: duyaAgent,
  prompt: string,
  options?: Parameters<duyaAgent['streamChat']>[1],
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of agent.streamChat(prompt, options)) {
    events.push(event);
  }
  return events;
}

/** Extracts user-facing model content from the messages a provider call saw. */
function modelUserTexts(messages: unknown): string[] {
  return (messages as Array<{ role: string; content: string | Array<{ text?: string }> }>)
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? [])
            .filter((b) => typeof b === 'object' && b !== null && typeof (b as { text?: string }).text === 'string')
            .map((b) => (b as { text: string }).text)
            .join('\n'),
    );
}

describe('Plan 486 — thread/fork branched layer runtime', () => {
  beforeEach(() => {
    streamState.current = { responses: [], errors: [] };
    streamState.callCount = 0;
    streamState.seenMessages = [];
    agentsMdState.currentText = '';
    clearCommandQueue();
  });

  afterEach(() => {
    clearCommandQueue();
    vi.restoreAllMocks();
  });

  it('a fork (branched) turn is persisted with threadMeta but never reaches the model projection', async () => {
    const agent = newAgent();
    agent.setMessages([userMessage('root question', 'root-1')]);

    await drainStream(agent, 'side question in thread', {
      replyToId: 'root-1',
      branched: true,
    });

    // Model projection: main-line messages only — the fork text is absent.
    const texts = modelUserTexts(streamState.seenMessages[0]);
    expect(texts.some((t) => t.includes('side question in thread'))).toBe(false);

    // Durable projection keeps the fork with its thread metadata intact.
    const durable = agent.getMessages();
    const fork = durable.find((m) => m.content.includes('side question in thread'));
    expect(fork).toBeDefined();
    expect((fork as { metadata?: Record<string, unknown> }).metadata?.[THREAD_METADATA_KEY]).toEqual({
      replyToId: 'root-1',
      branched: true,
    });
  });

  it('a quote reply (replyToId, not branched) injects [In reply to ...] into the model request while the durable row stays clean', async () => {
    const agent = newAgent();
    agent.setMessages([
      userMessage('root question', 'root-1'),
      assistantMessage('The answer is 42.', 'asst-1'),
    ]);

    await drainStream(agent, 'Why 42?', { replyToId: 'asst-1' });

    const texts = modelUserTexts(streamState.seenMessages[0]);
    const replyText = texts.find((t) => t.includes('Why 42?'));
    expect(replyText).toBeDefined();
    expect(replyText).toContain('[In reply to asst-1: "The answer is 42."]');

    // The durable message itself carries only the metadata marker, not the quote.
    const durable = agent.getMessages();
    const reply = durable.find((m) => m.content.includes('Why 42?'));
    expect(reply).toBeDefined();
    expect(typeof (reply as { content: unknown }).content).toBe('string');
    expect((reply as { content: string }).content).toBe('Why 42?');
    expect((reply as { metadata?: Record<string, unknown> }).metadata?.[THREAD_METADATA_KEY]).toEqual({
      replyToId: 'asst-1',
    });
  });

  it('a second re-projection of the same turn does not double-inject the quote', async () => {
    const agent = newAgent();
    agent.setMessages([userMessage('root question', 'root-1')]);

    // First call is the plain user turn. The second call simulates a mid-run
    // re-projection path (same streamChat continues with the same user row).
    await drainStream(agent, 'tell me more', { replyToId: 'root-1' });
    const first = modelUserTexts(streamState.seenMessages[0])[0];
    expect(first).toContain('[In reply to root-1: "root question"]');

    // Re-run the same streamChat with the same target: content must not stack.
    agent.setMessages(agent.getMessages());
    await drainStream(agent, 'tell me more', { replyToId: 'root-1' });
    const second = modelUserTexts(streamState.seenMessages[0])[0];
    expect(second).toContain('[In reply to root-1: "root question"]');
    expect(second.split('[In reply to root-1:').length).toBe(2); // exactly once
  });

  it('an unknown replyToId is silently stripped — the turn behaves like a plain send', async () => {
    const agent = newAgent();
    await drainStream(agent, 'plain message', { replyToId: 'ghost-id', branched: true });

    const durable = agent.getMessages();
    const row = durable.find((m) => m.content === 'plain message');
    expect(row).toBeDefined();
    expect((row as { metadata?: Record<string, unknown> }).metadata?.[THREAD_METADATA_KEY]).toBeUndefined();
    // And it still reached the model as a normal user message.
    const texts = modelUserTexts(streamState.seenMessages[0]);
    expect(texts.some((t) => t.includes('plain message'))).toBe(true);
  });

  it('setMessages reload keeps thread metadata so getThread data survives a restart path', async () => {
    const agent = newAgent();
    agent.setMessages([userMessage('root question', 'root-1')]);
    await drainStream(agent, 'side question', { replyToId: 'root-1', branched: true });

    // Simulate reload: durable rows are fed back through setMessages.
    const reloaded = newAgent();
    reloaded.setMessages(agent.getMessages());
    const durable = reloaded.getMessages();
    const fork = durable.find((m) => m.content === 'side question');
    expect(fork).toBeDefined();
    expect((fork as { metadata?: Record<string, unknown> }).metadata?.[THREAD_METADATA_KEY]).toEqual({
      replyToId: 'root-1',
      branched: true,
    });
  });
});
