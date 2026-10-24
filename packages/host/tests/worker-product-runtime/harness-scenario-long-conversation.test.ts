/**
 * Scenario 1 of the harness's own regression suite: the LONG CONVERSATION.
 *
 * ## What this file claims
 *
 * A model request must carry the question EXACTLY ONCE, at the END, as a user
 * turn, with no system-attached row behind it. That is the Model Request
 * boundary (`packages/ai/src/model-request-invariants.ts`), and the audit
 * proved it for ONE simple turn.
 *
 * This file proves it for the shape sessions actually have: a conversation
 * that has already gone on for a while, and a new question at the end of it.
 * The length matters because the ORDER is what a long conversation puts under
 * pressure -- the more history there is, the more likely the question is
 * displaced by a row the system attached, or re-sent by a row the engine
 * carries.
 *
 * ## The chain that is actually driven
 *
 *   real `duyaAgent` -> real `driveRunWithEngine` -> real `RunEngineImpl` ->
 *   real host projection -> the provider client
 *
 * The provider NETWORK call is the only thing that is not real. The rows the
 * provider client was handed are captured at that seam, and the REAL adapter
 * (`toAnthropicMessages` / `toResponsesInput`) is then run over them, so what
 * is asserted on is the payload the model would read -- the merged, reordered
 * wire shape -- and not the engine's intermediate array.
 *
 * That is the audit's own seam (`engine-payload-invariants.test.ts`), and it is
 * the only one that can be inspected: the payload builders are exported from
 * `@duya/ai` precisely so a request that reaches the wire can be proved
 * correct from a test.
 *
 * ## Every assertion has a counter-example
 *
 * The two arms at the bottom take the SAME real rows and rebuild the two
 * shapes the boundary exists to forbid -- the question at the FRONT, and the
 * question TWICE -- then assert the boundary REPORTS them. A checker that
 * never fails would pass the arm above and catch nothing, so the counter-
 * example arm is what makes the green one mean something.
 *
 * ## What this file does NOT claim
 *
 * It does not claim the request is CORRECT. It claims the request satisfies
 * the boundary. Whether the question is the RIGHT question is the host's
 * business.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. */
const QUESTION = 'LONG-CONVERSATION-QUESTION-MARKER';
/** A row the SYSTEM attached: the volatile-context rail. */
const RAIL_MARKER = 'This context was attached automatically by the system';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** How many prior exchanges the conversation carries before the new question. */
const PRIOR_EXCHANGES = 8;

/** The rows the provider client was handed, one entry per provider request. */
let captured: Message[][] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[]) {
      // A COPY, because the engine keeps its own array and pushes into it
      // between turns: reading it later would compare a value against its own
      // future mutation.
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

// The REAL adapters and the REAL boundary, straight out of the package the
// product ships.
const { toAnthropicMessages, toResponsesInput } = await import('@duya/ai/clients');
const {
  canonicalizeAnthropicPayload,
  canonicalizeOpenAIResponsesPayload,
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
      throw new Error(`unexpected db action in the long-conversation scenario: ${req.action}`);
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
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'harness-scenario-long-conversation');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-scenario-long-'));
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

/** Every text the payload carries, in the order the model would read them. */
function textsOf(payload: unknown): string[] {
  const canonical = canonicalizeAnthropicPayload(payload);
  return canonical.flatMap((row) => row.texts);
}

/** Drive the real chain and return the rows the provider client was handed. */
async function driveLongConversation(): Promise<Message[]> {
  installDbIpc();
  const agent = makeWorkerSession({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: 's-harness-scenario-long',
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  agent.setMessages(priorConversation() as never);

  await driveTurn(agent, QUESTION, {
    options: { sessionId: 's-harness-scenario-long', clientMsgId: 'client-msg-long' } as never,
  });

  expect(captured.length).toBe(1);
  return captured[0]!;
}

describe('a long conversation still ends with the question', () => {
  it('carries the question once, last, on the payload the model reads', async () => {
    const rows = await driveLongConversation();

    // ── Non-vacuity FIRST ───────────────────────────────────────────────
    // A request that carried nothing would satisfy nothing, so the check
    // below has to have something to check.
    expect(rows.length).toBeGreaterThan(PRIOR_EXCHANGES * 2);

    // The conversation really was long: every prior turn is still in front.
    for (let index = 0; index < PRIOR_EXCHANGES; index += 1) {
      expect(rows.some((row) => row.content === `prior question ${index}`)).toBe(true);
      expect(rows.some((row) => row.content === `prior answer ${index}`)).toBe(true);
    }

    // The rail really rode this request -- otherwise the claim below would
    // be about a request that happens to have no context in it.
    const railRows = rows.filter((row) => String(row.content).includes(RAIL_MARKER));
    expect(railRows.length).toBeGreaterThan(0);

    // ── The claim, on the FINAL payload the adapter produces ───────────
    const anthropicPayload = toAnthropicMessages(rows, ANTHROPIC_MODEL);
    const responsesPayload = toResponsesInput(rows);

    expect(
      checkModelRequest(canonicalizeAnthropicPayload(anthropicPayload), { question: QUESTION }),
    ).toEqual([]);
    expect(
      checkModelRequest(canonicalizeOpenAIResponsesPayload(responsesPayload), { question: QUESTION }),
    ).toEqual([]);

    // Exactly once, on the wire shape the model reads. Anthropic merges
    // consecutive `user` rows into ONE block, so this counts TEXTS rather
    // than rows: a question sent twice is two texts even when it is one row.
    const anthropicTexts = textsOf(anthropicPayload);
    expect(anthropicTexts.filter((text) => text.includes(QUESTION))).toHaveLength(1);

    // And last: the request's final text is the question, so the model's
    // last read is the question rather than a row the system attached.
    expect(anthropicTexts[anthropicTexts.length - 1]).toContain(QUESTION);
  });

  it('REPORTS the question when it is moved to the front', async () => {
    const rows = await driveLongConversation();

    // The counter-example: the SAME real rows, with the question moved back
    // behind the conversation -- the shape the defect took.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [
      questionRow,
      ...rows.slice(0, questionIndex),
      ...rows.slice(questionIndex + 1),
    ];

    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(toAnthropicMessages(regressed, ANTHROPIC_MODEL)),
      { question: QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_NOT_LAST');
  });

  it('REPORTS the question when it is sent twice', async () => {
    const rows = await driveLongConversation();

    // The counter-example: the SAME real rows, with a SECOND copy of the
    // question at the front. The original stays where it was, so the request
    // now carries the question twice -- once at the front, once at the end.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [questionRow, ...rows];

    const violations = checkModelRequest(
      canonicalizeOpenAIResponsesPayload(toResponsesInput(regressed)),
      { question: QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_DUPLICATED');
  });
});
