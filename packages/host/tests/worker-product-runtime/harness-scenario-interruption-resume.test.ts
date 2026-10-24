/**
 * Scenario 4 of the harness's own regression suite: INTERRUPTION AND RESUME.
 *
 * ## What this file claims
 *
 * A user can stop a run and then ask again. The second turn is a NEW run on
 * the SAME session, and the request it opens is the one that has to satisfy
 * the boundary: the new question is carried EXACTLY ONCE, at the END, as a
 * user turn, with no system-attached row behind it.
 *
 * The interrupted turn's question is still part of the session, so it is
 * still in the request -- as history, in the place the conversation put it.
 * That is the point of the scenario: a resumed request carries MORE than one
 * question, and only one of them may be the question the model is being
 * asked NOW.
 *
 * ## The interruption is a real one
 *
 * The run is aborted while the provider call is in flight: the client waits
 * for the abort signal and then dies with an `AbortError`, which is what a
 * real transport does when the caller stops the run. The first arm asserts
 * that the run really ended cancelled, so a "resume" that never had anything
 * to resume from cannot pass.
 *
 * ## The chain that is actually driven
 *
 *   real `duyaAgent` -> real `driveRunWithEngine` -> real `RunEngineImpl` ->
 *   real host projection -> the provider client
 *
 * The provider network call is the only fake. The rows the provider client
 * was handed are captured at that seam and the REAL adapters
 * (`toAnthropicMessages` / `toResponsesInput`) are run over them.
 *
 * ## Every assertion has a counter-example
 *
 * Two arms at the bottom take the SAME real rows and rebuild the two shapes
 * the boundary exists to forbid -- the resumed question moved to the FRONT,
 * and the resumed question sent TWICE -- and assert the boundary REPORTS
 * them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The question the interrupted run was asked. */
const INTERRUPTED_QUESTION = 'INTERRUPTED-QUESTION-MARKER';
/** The question the resumed run is asked. */
const RESUMED_QUESTION = 'RESUMED-QUESTION-MARKER';
/** A row the SYSTEM attached: the volatile-context rail. */
const RAIL_MARKER = 'This context was attached automatically by the system';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** The rows the provider client was handed, one entry per provider request. */
let captured: Message[][] = [];
/** Set while the first (interrupted) turn is in flight. */
let interruptNow: (() => void) | null = null;

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      captured.push(
        messages.map((row) => ({
          ...row,
          ...(Array.isArray(row.content) ? { content: row.content.map((block) => ({ ...block })) } : {}),
        })),
      );
      const signal = options?.signal as AbortSignal | undefined;
      const isFirst = captured.length === 1;
      return (async function* () {
        if (isFirst) {
          // The run is stopped while the provider call is in flight. The
          // call waits for the abort and then dies the way a real transport
          // dies: with an AbortError, not with a graceful answer.
          interruptNow?.();
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        yield { type: 'text', data: 'the resumed answer' } as SSEEvent;
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
      throw new Error(`unexpected db action in the interruption scenario: ${req.action}`);
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
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'harness-scenario-interruption-resume');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  interruptNow = null;
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-scenario-resume-'));
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

/** Drive the interrupted run and the resumed run, and return both requests. */
async function driveInterruptAndResume(): Promise<Message[][]> {
  installDbIpc();
  const sessionId = 's-harness-scenario-resume';

  const agent = makeWorkerSession({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  interruptNow = () => agent.interrupt();

  const interrupted = await driveTurn(agent, INTERRUPTED_QUESTION, {
    options: { sessionId, clientMsgId: 'client-msg-interrupted' } as never,
  });
  // The run really was stopped: a resume that never had anything to resume
  // from would satisfy the rest of this file trivially.
  expect(interrupted.outcome.terminal?.status).toBe('cancelled');

  const resumed = await driveTurn(agent, RESUMED_QUESTION, {
    options: { sessionId, clientMsgId: 'client-msg-resumed' } as never,
  });
  expect(resumed.outcome.terminal?.status).toBe('completed');

  expect(captured.length).toBe(2);
  return captured;
}

/** The payload the REAL Anthropic adapter produces for the given rows. */
function payloadFor(rows: readonly Message[]): unknown {
  return toAnthropicMessages(rows as Message[], ANTHROPIC_MODEL);
}

/** Every text the Anthropic payload carries, in the order the model reads them. */
function textsOf(payload: unknown): string[] {
  return canonicalizeAnthropicPayload(payload).flatMap((row) => row.texts);
}

describe('a resumed session still ends with the question', () => {
  it('carries the resumed question once, last, on the payload the model reads', async () => {
    const requests = await driveInterruptAndResume();
    const resumedRows = requests[1]!;
    const payload = payloadFor(resumedRows);
    const texts = textsOf(payload);

    // ── Non-vacuity FIRST ───────────────────────────────────────────────
    // The request really carried a conversation: the interrupted question is
    // still in it, as history.
    expect(resumedRows.length).toBeGreaterThan(1);
    expect(texts.filter((text) => text.includes(INTERRUPTED_QUESTION))).toHaveLength(1);

    // The rail really rode this request -- otherwise the claim below would
    // be about a request that happens to have no context in it.
    expect(
      resumedRows.filter((row) => String(row.content).includes(RAIL_MARKER)).length,
    ).toBeGreaterThan(0);

    // ── The claim, on the FINAL payload the adapter produces ───────────
    expect(
      checkModelRequest(canonicalizeAnthropicPayload(payload), { question: RESUMED_QUESTION }),
    ).toEqual([]);
    expect(
      checkModelRequest(canonicalizeOpenAIResponsesPayload(toResponsesInput(resumedRows)), {
        question: RESUMED_QUESTION,
      }),
    ).toEqual([]);

    // Exactly once, and last: the model's last read is the new question,
    // not the interrupted one and not a row the system attached.
    expect(texts.filter((text) => text.includes(RESUMED_QUESTION))).toHaveLength(1);
    expect(texts[texts.length - 1]).toContain(RESUMED_QUESTION);
  });

  it('REPORTS the resumed question when it is moved to the front', async () => {
    const requests = await driveInterruptAndResume();
    const rows = requests[1]!;

    // The counter-example: the SAME real rows, with the resumed question
    // moved back behind the conversation.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(RESUMED_QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [
      questionRow,
      ...rows.slice(0, questionIndex),
      ...rows.slice(questionIndex + 1),
    ];

    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(payloadFor(regressed)),
      { question: RESUMED_QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_NOT_LAST');
  });

  it('REPORTS the resumed question when it is sent twice', async () => {
    const requests = await driveInterruptAndResume();
    const rows = requests[1]!;

    // The counter-example: the SAME real rows, with a second copy of the
    // resumed question at the end.
    //
    // Checked on the OpenAI Responses payload, and the reason is worth
    // stating: Anthropic MERGES consecutive `user` rows into one block, and
    // a resumed session's rows are all `user` rows, so a duplicate folded
    // into that block is invisible to a ROW-level check on the Anthropic
    // payload. The Responses adapter keeps the rows apart, so the duplicate
    // is a duplicate there -- which is exactly the difference between the
    // two wire shapes.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(RESUMED_QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [...rows, questionRow];

    const violations = checkModelRequest(
      canonicalizeOpenAIResponsesPayload(toResponsesInput(regressed)),
      { question: RESUMED_QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_DUPLICATED');
  });
});
