/**
 * Plan 475 P4.6 follow-up — manual /compact emits the compaction callback.
 *
 * Regression for the ghost-history gap found in the 475 P4.6 audit: the
 * manual `agent.compact()` path (worker `compact` command) never invoked
 * `onMessagesCompacted`, so the worker's journal wiring never emitted a
 * `rebase` event. Compacted-away messages were therefore never superseded
 * in the rollout, and a reload resurrected the full pre-compaction history
 * alongside the summary.
 *
 * The proactive path (streamChat) already fired the callback; this suite
 * pins the manual path to the same contract:
 *   1. successful compaction → callback fired once with the post-compact
 *      message count
 *   2. strategy 'none' (no compaction entry) → callback NOT fired
 *   3. empty timeline → throws, callback NOT fired
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/providers/index.js', () => ({
  createProvider: vi.fn(() => ({
    streamChat: vi.fn(async function* () {
      yield { type: 'result', data: { content: [] } };
    }),
    name: 'mock',
  })),
}));

vi.mock('../../../src/agentsMd/index.js', () => ({
  initializeAgentsMd: vi.fn(async () => ({
    exists: false,
    text: '',
    hasFiles: vi.fn(() => false),
    getFileCount: vi.fn(() => 0),
  })),
}));

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import type { Message } from '../../../src/types.js';
import { clearCommandQueue } from '../../../src/queue/index.js';
import { webcrypto } from 'node:crypto';

// Node 18's vitest node environment lacks the global `crypto` binding that
// duyaAgent's constructor uses for session ids (plan315 suite has the same
// exposure). Install the webcrypto shim before constructing agents.
if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

function newAgent(): duyaAgent {
  return new duyaAgent({
    apiKey: 'test-key',
    provider: 'anthropic',
    model: 'test-model',
    enableRetry: false,
  });
}

function seedMessages(agent: duyaAgent, n: number): void {
  const messages: Message[] = [];
  for (let i = 0; i < n; i++) {
    messages.push({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} — filler for compaction`,
      timestamp: 1700000000000 + i,
    });
  }
  agent.setMessages(messages);
}

type ControllerStub = {
  compactProactive: (opts?: unknown) => Promise<{
    strategy: string;
    tokensBefore: number;
    tokensAfter?: number;
    compactedMessageIds?: string[];
    firstKeptMessageId?: string;
  } | null>;
};

function stubController(
  agent: duyaAgent,
  result: ReturnType<typeof makeEntry> | null,
): void {
  const store = agent as unknown as {
    compactionController: ControllerStub;
  };
  store.compactionController = {
    compactProactive: async () => result,
  };
}

function makeEntry(kept: number) {
  return {
    strategy: 'session_memory',
    tokensBefore: 1000,
    tokensAfter: 400,
    compactedMessageIds: Array.from({ length: kept }, (_, i) => `m-${i}`),
    firstKeptMessageId: `m-${kept}`,
  };
}

describe('Plan 475 — manual compact emits onMessagesCompacted (rebase parity)', () => {
  beforeEach(() => {
    clearCommandQueue();
  });

  afterEach(() => {
    clearCommandQueue();
    vi.restoreAllMocks();
  });

  it('fires onMessagesCompacted once after a successful manual compact', async () => {
    const agent = newAgent();
    seedMessages(agent, 10);
    stubController(agent, makeEntry(6));

    const onCompacted = vi.fn();
    agent.onMessagesCompacted = onCompacted;

    const result = await agent.compact({});

    expect(result.strategy).toBe('session_memory');
    expect(onCompacted).toHaveBeenCalledTimes(1);
    // The callback receives the post-compaction projected message count.
    expect(onCompacted).toHaveBeenCalledWith(agent.getMessages().length);
  });

  it('does NOT fire the callback when the strategy returns none', async () => {
    const agent = newAgent();
    seedMessages(agent, 10);
    stubController(agent, null);

    const onCompacted = vi.fn();
    agent.onMessagesCompacted = onCompacted;

    const result = await agent.compact({});
    expect(result.strategy).toBe('none');
    expect(onCompacted).not.toHaveBeenCalled();
  });

  it('throws on an empty timeline and never fires the callback', async () => {
    const agent = newAgent();
    const onCompacted = vi.fn();
    agent.onMessagesCompacted = onCompacted;

    await expect(agent.compact({})).rejects.toThrow(/empty/i);
    expect(onCompacted).not.toHaveBeenCalled();
  });
});
