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

// --- Mocked DB so DuyaAgent can be constructed without IPC --------------------
// `messageDb` is here because the run driver commits real rows through the
// agent's `Journal`, which imports it at module load. Pre-flip these suites
// never reached a Journal, so the stub carried only the two mailbox/plugin
// tables `streamChat` claimed; the flip made the durable sink a participant.

vi.mock('../../../src/ipc/db-client.js', () => ({
  mailboxDb: {
    claimBatch: vi.fn(async () => ({ rows: [], claimTokens: [] })),
    apply: vi.fn(async () => ({})),
    markObserved: vi.fn(async () => ({})),
  },
  pluginDb: {
    list: vi.fn(async () => []),
  },
  messageDb: {
    append: vi.fn(async (_sessionId: string, messages: unknown[]) => ({
      success: true,
      count: messages.length,
    })),
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
import {
  cleanupEngineTurnDirs,
  driveTurn,
  installEngineTurnIpc,
  restoreEngineTurnIpc,
} from '../../helpers/engineTurnHarness.js';

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

/**
 * Drive one real turn through the run driver.
 *
 * `DuyaAgent.streamChat` no longer exists (plan 610 A3 / S4c-d3): the turn loop
 * belongs to `driveRunWithEngine` and the agent is a set of ports beneath it.
 * The claim under test is unchanged by that move -- it was always "what the
 * PROVIDER was handed as its system prompt" -- so the assertion still reads the
 * same capture off the same `@duya/ai` boundary, one layer further out.
 */
async function drainStream(
  agent: duyaAgent,
  prompt: string | MessageContent[],
  options?: Parameters<typeof driveTurn>[2],
): Promise<void> {
  await driveTurn(agent, prompt, options ?? {});
}

describe('Plan 408 Phase 5 — DuyaAgent omitAgentsMd', () => {
  beforeEach(async () => {
    streamState.callCount = 0;
    streamState.seenMessages = [];
    streamState.seenTools = [];
    streamState.seenSystemPrompts = [];
    agentsMdState.currentText = AGENTS_MD_MARKER;
    clearCommandQueue();
    await installEngineTurnIpc();
  });

  afterEach(() => {
    clearCommandQueue();
    restoreEngineTurnIpc();
    cleanupEngineTurnDirs();
    vi.restoreAllMocks();
  });

  it('includes AGENTS.md in the system prompt by default', async () => {
    const agent = newAgent();
    await drainStream(agent, 'hello');

    // The turn really ran: without this a driver that never opened a request
    // would satisfy the assertion below with an empty capture.
    expect(streamState.callCount).toBeGreaterThan(0);
    const systemPrompt = streamState.seenSystemPrompts[0] ?? '';
    expect(systemPrompt).toContain(AGENTS_MD_MARKER);
  });

  it('omits AGENTS.md from the system prompt when omitAgentsMd=true', async () => {
    const agent = newAgent({ omitAgentsMd: true });
    await drainStream(agent, 'hello');

    // Same guard, for the same reason: a NEGATIVE assertion is satisfied by a
    // turn that never issued a request, so the run is proved first.
    expect(streamState.callCount).toBeGreaterThan(0);
    const systemPrompt = streamState.seenSystemPrompts[0] ?? '';
    expect(systemPrompt).not.toContain(AGENTS_MD_MARKER);
  });
});
