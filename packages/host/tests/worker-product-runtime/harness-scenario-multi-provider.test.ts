/**
 * Scenario 5 of the harness's own regression suite: the MULTI-PROVIDER SWITCH.
 *
 * ## What this file claims
 *
 * The boundary is provider-agnostic, and each adapter spells a row its own
 * way: Anthropic merges consecutive `user` rows into ONE block and reorders
 * tool results around their calls, OpenAI Responses keeps the rows as
 * separate `input` items, Gemini calls the text carrier `parts` and the
 * model's own turn `model`, Bedrock carries blocks instead of strings.
 *
 * A request that satisfies the boundary on one provider can still break it
 * on another -- and the Anthropic merge in particular can turn a duplicated
 * question into one invisible block. So the same conversation has to be
 * checked on every provider the product ships.
 *
 * ## The chain that is actually driven
 *
 *   real `duyaAgent` -> real `driveRunWithEngine` -> real `RunEngineImpl` ->
 *   real host projection -> the provider client
 *
 * The rows are captured at the provider seam ONCE, and then the REAL
 * adapter of each provider is run over THOSE SAME ROWS. That is what makes
 * this a provider comparison rather than five separate conversations: the
 * inputs are identical, so a difference in the verdict is a difference in the
 * adapter.
 *
 * ## Every assertion has a counter-example
 *
 * For every adapter, the two arms at the bottom rebuild the two shapes the
 * boundary exists to forbid -- the question at the FRONT, and the question
 * TWICE -- from the SAME real rows, and assert the boundary REPORTS them. A
 * provider whose adapter could not see a regression would fail here, and
 * that is the point of running the matrix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. */
const QUESTION = 'MULTI-PROVIDER-QUESTION-MARKER';
/** A row the SYSTEM attached: the volatile-context rail. */
const RAIL_MARKER = 'This context was attached automatically by the system';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** How many prior exchanges the conversation carries before the new question. */
const PRIOR_EXCHANGES = 4;

/** The rows the provider client was handed, one entry per provider request. */
let captured: Message[][] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[]) {
      captured.push(
        messages.map((row) => ({
          ...row,
          ...(Array.isArray(row.content) ? { content: row.content.map((block) => ({ ...block })) } : {}),
        })),
      );
      return (async function* () {
        yield { type: 'text', data: 'ok' } as SSEEvent;
        yield DONE;
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// Captured BEFORE the harness and the db-client are imported: importing the
// db-client registers its own `'message'` listener, and a listener captured
// after that would look like a pool listener and be filtered out.
const POOL_LISTENERS = new Set(process.listeners('message'));

/**
 * The process's OWN send channel, captured once.
 *
 * The fake below replaces it for the duration of a test, and the teardown
 * puts THIS back -- not whatever the fake left behind. Capturing it per
 * install would capture the fake on the second test and leave a fake
 * `process.send` behind for the next file in the pool.
 */
const ORIGINAL_SEND = process.send;

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } =
  await import('./engine-turn-harness.js');
const { initDbClient } = await import('@duya/host/worker-db-client');

const {
  toAnthropicMessages,
  toResponsesInput,
  toOpenAIMessages,
  toGeminiContents,
  toBedrockMessages,
  canonicalizeAnthropicPayload,
  canonicalizeOpenAIResponsesPayload,
  canonicalizeOpenAICompletionsPayload,
  canonicalizeGeminiPayload,
  canonicalizeBedrockPayload,
  checkModelRequest,
} = await import('@duya/ai');

const ANTHROPIC_MODEL = {
  id: 'claude-test',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportsReasoning: false,
  supportsPromptCaching: true,
  inputPricePerMillion: 3,
  outputPricePerMillion: 15,
  supportedApiFormats: ['anthropic'],
} as never;

const originalEnv = { ...process.env };
let cachedDbListener: ((m: unknown) => void) | null = null;
let workspaceDir = '';

/**
 * Answer the DB actions this turn reaches for.
 *
 * Under a Vitest pool worker `process.send` is the POOL's channel, so it is
 * replaced and the db-client's own listener is called directly. The set of
 * allowed actions is EXPLICIT: anything else arriving is a test-visible
 * failure rather than a hang.
 */
function installDbIpc(): void {
  if (cachedDbListener === null) {
    initDbClient();
    cachedDbListener = (process
      .listeners('message')
      .filter((listener) => !POOL_LISTENERS.has(listener))[0] ?? null) as
      | ((m: unknown) => void)
      | null;
    if (cachedDbListener === null) throw new Error('db-client registered no message listener');
  }
  const dbListener = cachedDbListener;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string; payload?: { messages?: unknown[] } };
    if (req?.type !== 'db:request') return true;
    if (
      req.action !== 'mailbox:claimBatch' &&
      req.action !== 'message:append' &&
      req.action !== 'journal:emit' &&
      req.action !== 'modeState:get'
    ) {
      throw new Error(`unexpected db action in the multi-provider scenario: ${req.action}`);
    }
    const result =
      req.action === 'mailbox:claimBatch'
        ? { rows: [], claimTokens: [] }
        : req.action === 'message:append'
          ? { success: true, count: req.payload?.messages?.length ?? 0 }
          : { success: true };
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'harness-scenario-multi-provider');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-scenario-providers-'));
});

afterEach(() => {
  process.send = ORIGINAL_SEND;
  cleanupEngineTurnDirs();
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // A temp dir nobody claimed is not a test failure.
  }
});

/** One provider's adapter, and the reducer for its payload shape. */
interface Adapter {
  readonly name: string;
  /** The adapter's final payload for the given rows. */
  readonly payload: (rows: readonly Message[]) => unknown;
  /** The reducer for that payload shape. */
  readonly canonicalize: (payload: unknown) => ReturnType<typeof canonicalizeAnthropicPayload>;
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'anthropic',
    payload: (rows) => toAnthropicMessages(rows as Message[], ANTHROPIC_MODEL),
    canonicalize: canonicalizeAnthropicPayload,
  },
  {
    name: 'openai-responses',
    payload: (rows) => toResponsesInput(rows as Message[]),
    canonicalize: canonicalizeOpenAIResponsesPayload,
  },
  {
    name: 'openai-completions',
    payload: (rows) => toOpenAIMessages(rows as Message[]),
    canonicalize: canonicalizeOpenAICompletionsPayload,
  },
  {
    name: 'gemini',
    payload: (rows) => toGeminiContents(rows as Message[]),
    canonicalize: canonicalizeGeminiPayload,
  },
  {
    name: 'bedrock',
    payload: (rows) => toBedrockMessages(rows as Message[]),
    canonicalize: canonicalizeBedrockPayload,
  },
];

/** A conversation that has already gone on for a while. */
function priorConversation(): Message[] {
  const rows: Message[] = [];
  for (let index = 0; index < PRIOR_EXCHANGES; index += 1) {
    rows.push({
      id: `prior-user-${index}`,
      role: 'user',
      content: `prior question ${index}`,
      timestamp: Date.now(),
    } as never);
    rows.push({
      id: `prior-assistant-${index}`,
      role: 'assistant',
      content: `prior answer ${index}`,
      timestamp: Date.now(),
    } as never);
  }
  return rows;
}

/** Drive the real chain ONCE and return the rows every adapter is fed. */
async function driveOneConversation(): Promise<Message[]> {
  installDbIpc();
  const agent = makeWorkerSession({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: 's-harness-scenario-providers',
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  agent.setMessages(priorConversation() as never);

  await driveTurn(agent, QUESTION, {
    options: { sessionId: 's-harness-scenario-providers', clientMsgId: 'client-msg-providers' } as never,
  });

  expect(captured.length).toBe(1);
  return captured[0]!;
}

describe.each(ADAPTERS)('the $name payload', (adapter) => {
  it('carries the question once, last', async () => {
    const rows = await driveOneConversation();

    // ── Non-vacuity FIRST ───────────────────────────────────────────────
    // The conversation really was long, and the rail really rode the
    // request. A payload built from a request with neither would satisfy
    // nothing.
    expect(rows.length).toBeGreaterThan(PRIOR_EXCHANGES * 2);
    expect(rows.filter((row) => String(row.content).includes(RAIL_MARKER)).length).toBeGreaterThan(0);

    const canonical = adapter.canonicalize(adapter.payload(rows));
    expect(canonical.length).toBeGreaterThan(0);

    // ── The claim ───────────────────────────────────────────────────────
    expect(checkModelRequest(canonical, { question: QUESTION })).toEqual([]);

    // Exactly once, and last, on the wire shape this provider reads.
    const texts = canonical.flatMap((row) => row.texts);
    expect(texts.filter((text) => text.includes(QUESTION))).toHaveLength(1);
    expect(texts[texts.length - 1]).toContain(QUESTION);
  });

  it('is REPORTED when the question is moved to the front', async () => {
    const rows = await driveOneConversation();

    // The counter-example: the SAME real rows, with the question moved back
    // behind the conversation.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [
      questionRow,
      ...rows.slice(0, questionIndex),
      ...rows.slice(questionIndex + 1),
    ];

    const violations = checkModelRequest(adapter.canonicalize(adapter.payload(regressed)), {
      question: QUESTION,
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_NOT_LAST');
  });

  it('is REPORTED when the question is sent twice', async () => {
    const rows = await driveOneConversation();

    // The counter-example: the SAME real rows, with a SECOND copy of the
    // question at the front. The original stays where it was, so the
    // request now carries the question twice.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [questionRow, ...rows];

    const violations = checkModelRequest(adapter.canonicalize(adapter.payload(regressed)), {
      question: QUESTION,
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_DUPLICATED');
  });
});
