/**
 * Thinking-replay regression tests for the DuyaAgent streaming loop.
 *
 * Mid-run thinking blocks must be pushed back into the message list as
 * native signed blocks (thinkingSignature) with per-message model
 * attribution (providerId/model/api), so the next round's request passes
 * transformMessages.isSameModel and the provider receives the thinking
 * chain it needs to continue (Anthropic thinking mode / DeepSeek
 * reasoning_content passback). Mirrors ZCode's reasoning-history replay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '../../../src/types.js';

// Non-literal placeholder for the mocked client (never a real credential).
const FAKE_API_KEY = ['test', 'key'].join('-');

// --- Mocked LLM client (same harness as DuyaAgent.plan315.test.ts) ---------

interface StreamConfig {
  /** Per-call scripted SSE events. Each entry = one streamChat call. */
  responses: SSEEvent[][];
}

const streamState = vi.hoisted(() => ({
  current: { responses: [] as SSEEvent[][] } as StreamConfig,
  callCount: 0,
  /** Captures the messages array passed to each streamChat invocation. */
  seenMessages: [] as unknown[][],
}));

vi.mock('@duya/ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@duya/ai')>();
  const mockClient = (): unknown => ({
    streamChat: vi.fn(async function* (messages: unknown[]) {
      streamState.callCount += 1;
      streamState.seenMessages.push(messages);
      const index = streamState.callCount - 1;
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
    buildAgentsMdSection: vi.fn(() => agentsMdState.currentText),
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
import { clearCommandQueue } from '../../../src/queue/index.js';

function newAgent(options: Record<string, unknown> = {}): duyaAgent {
  return new duyaAgent({
    apiKey: FAKE_API_KEY,
    provider: 'anthropic',
    model: 'test-model',
    enableRetry: false,
    ...options,
  });
}

async function drainStream(
  agent: duyaAgent,
  prompt: string,
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of agent.streamChat(prompt)) {
    events.push(event);
  }
  return events;
}

function findAssistantWithThinking(messages: Message[]): {
  message: Message;
  thinking: Extract<MessageContent, { type: 'thinking' }>;
} | undefined {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const thinking = message.content.find(
      (block): block is Extract<MessageContent, { type: 'thinking' }> =>
        block.type === 'thinking',
    );
    if (thinking) return { message, thinking };
  }
  return undefined;
}

describe('DuyaAgent thinking replay', () => {
  beforeEach(() => {
    streamState.current = { responses: [] };
    streamState.callCount = 0;
    streamState.seenMessages = [];
    agentsMdState.currentText = '';
    clearCommandQueue();
  });

  afterEach(() => {
    clearCommandQueue();
    vi.restoreAllMocks();
  });

  it('pushes a signed thinking block with model attribution before tool results', async () => {
    const agent = newAgent();
    streamState.current = {
      responses: [
        // Round 1: thinking (deltas + signature-only event) then a tool call.
        [
          { type: 'thinking', data: 'I need to ' },
          { type: 'thinking', data: 'run the tool' },
          { type: 'thinking', data: '', signature: 'sig-123' },
          {
            type: 'tool_use',
            data: { id: 'tu-1', name: 'echo', input: { msg: 'x' } },
          },
          { type: 'done' },
        ],
        // Round 2: model finishes after seeing the result.
        [
          { type: 'text', data: 'all done' },
          { type: 'done' },
        ],
      ],
    };

    await drainStream(agent, 'run the tool');
    expect(streamState.callCount).toBe(2);

    // Round 2's request carries the assistant message with its thinking.
    const round2 = streamState.seenMessages[1] as Message[];
    const found = findAssistantWithThinking(round2);
    expect(found).toBeDefined();
    const { message, thinking } = found!;
    expect(thinking.thinking).toBe('I need to run the tool');
    expect(thinking.thinkingSignature).toBe('sig-123');

    // The signature-only empty-data event must not duplicate content.
    expect(thinking.thinking).not.toContain('sig-123');

    // Per-message attribution so isSameModel keeps the block native.
    expect(message.providerId).toBe('anthropic');
    expect(message.model).toBe('test-model');
    expect(message.api).toBe('anthropic');

    // Assistant precedes its tool results (OpenAI/Anthropic ordering).
    const toolIndex = round2.findIndex(
      (m) =>
        m.role === 'tool' ||
        (Array.isArray(m.content) &&
          (m.content as MessageContent[]).some((c) => c.type === 'tool_result')),
    );
    const assistantIndex = round2.indexOf(message);
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeLessThan(toolIndex);
  });

  it('still attributes unsigned thinking rounds (signature stays absent)', async () => {
    const agent = newAgent({ provider: 'openai', model: 'gpt-x' });
    streamState.current = {
      responses: [
        [
          { type: 'thinking', data: 'plain reasoning' },
          { type: 'text', data: 'answer' },
          { type: 'done' },
        ],
      ],
    };

    await drainStream(agent, 'hello');
    expect(streamState.callCount).toBe(1);

    const durable = (agent.getMessages() as Message[]).find(
      (m) => m.role === 'assistant' && Array.isArray(m.content) &&
        (m.content as MessageContent[]).some((c) => c.type === 'thinking'),
    );
    expect(durable).toBeDefined();
    const thinking = (durable!.content as MessageContent[]).find(
      (c): c is Extract<MessageContent, { type: 'thinking' }> => c.type === 'thinking',
    )!;
    expect(thinking.thinking).toBe('plain reasoning');
    expect(thinking.thinkingSignature).toBeUndefined();

    expect(durable!.providerId).toBe('openai');
    expect(durable!.model).toBe('gpt-x');
    expect(durable!.api).toBe('openai-chat');
  });
});
