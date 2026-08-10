/**
 * Plan 408 Phase 2 — DuyaAgent omitAgentsMd AGENTS.md injection short-circuit.
 *
 * Built-in read-only sub-agents (Explore / Plan / CodeReview / Research) run
 * through `duyaAgent.streamChat`. On the first turn, DuyaAgent unshifts the
 * AGENTS.md snapshot as an ephemeral user message (Codex-compatible). When the
 * agent is constructed with `omitAgentsMd: true`, that injection must be
 * skipped entirely — otherwise the whole snapshot (5-50K tokens) is billed on
 * every sub-agent turn for instructions the read-only agent does not need.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '../../../src/types.js';

// --- Mocked LLM client (captures messages sent to the provider) ------------

const streamState = vi.hoisted(() => ({
  callCount: 0,
  /** Captures the messages array passed to each streamChat invocation. */
  seenMessages: [] as unknown[][],
  seenTools: [] as unknown[][],
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
      yield { type: 'text', data: 'ok' };
      yield { type: 'done' };
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
import { clearCommandQueue } from '../../../src/queue/index.js';

const AGENTS_MD_MARKER = 'AGENTS_MD_MARKER_12345';

function newAgent(options: Record<string, unknown> = {}): duyaAgent {
  return new duyaAgent({
    apiKey: 'test-key',
    provider: 'anthropic',
    model: 'test-model',
    enableRetry: false,
    ...options,
  });
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

function firstTurnTexts(): string[] {
  const messages = streamState.seenMessages[0] as Array<{
    role: string;
    content: string | unknown[];
  }>;
  return (messages ?? []).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  );
}

describe('Plan 408 Phase 2 — DuyaAgent omitAgentsMd', () => {
  beforeEach(() => {
    streamState.callCount = 0;
    streamState.seenMessages = [];
    streamState.seenTools = [];
    streamState.seenSystemPrompts = [];
    agentsMdState.currentText = AGENTS_MD_MARKER;
    clearCommandQueue();
  });

  afterEach(() => {
    clearCommandQueue();
    vi.restoreAllMocks();
  });

  it('injects AGENTS.md as first user message on turn 1 by default', async () => {
    const agent = newAgent();
    await drainStream(agent, 'hello');

    const texts = firstTurnTexts();
    expect(texts.some((t) => t.includes(AGENTS_MD_MARKER))).toBe(true);
  });

  it('skips AGENTS.md injection on turn 1 when omitAgentsMd=true', async () => {
    const agent = newAgent({ omitAgentsMd: true });
    await drainStream(agent, 'hello');

    const texts = firstTurnTexts();
    expect(texts.some((t) => t.includes(AGENTS_MD_MARKER))).toBe(false);
  });
});
