/**
 * Plan 408 Phase 5 — DuyaAgent omitAgentsMd in the system prompt.
 *
 * AGENTS.md now lives in the system field (so it sits on the system-prefix
 * cache breakpoint). Read-only sub-agents (Explore / Plan / CodeReview /
 * Research) construct DuyaAgent with `omitAgentsMd: true`, which must keep
 * the AGENTS.md section OUT of the system prompt — otherwise the whole
 * snapshot (5-50K tokens) is billed on every sub-agent turn for conventions
 * the read-only agent does not need.
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
import type { MessageContent } from '../../../src/types.js';
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

describe('Plan 408 Phase 5 — DuyaAgent omitAgentsMd', () => {
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

  it('includes AGENTS.md in the system prompt by default', async () => {
    const agent = newAgent();
    await drainStream(agent, 'hello');

    const systemPrompt = streamState.seenSystemPrompts[0] ?? '';
    expect(systemPrompt).toContain(AGENTS_MD_MARKER);
  });

  it('omits AGENTS.md from the system prompt when omitAgentsMd=true', async () => {
    const agent = newAgent({ omitAgentsMd: true });
    await drainStream(agent, 'hello');

    const systemPrompt = streamState.seenSystemPrompts[0] ?? '';
    expect(systemPrompt).not.toContain(AGENTS_MD_MARKER);
  });
});
