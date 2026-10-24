/**
 * The request the MODEL reads, end to end.
 *
 * ## Why this file is not the same claim as `engine-prompt-order-proof`
 *
 * That file proves the request's LAST ROW is the question, and it stops
 * where the engine stops: it mocks `createAIClient` and reads the rows the
 * engine handed over. That is one step short of the model.
 *
 * The step it stops short of is the one that rewrites the request. The
 * Anthropic adapter merges consecutive `user` rows into ONE block, and the
 * model reads that block's TAIL. So "the engine's last row is the question"
 * and "the model's last words are the question" are different claims, and
 * only the second one is about the defect.
 *
 * This file therefore runs the rows the engine produced through the REAL
 * adapter and checks the boundary on the payload that comes out. Nothing
 * here is mocked except the network call itself.
 *
 * ## What it claims
 *
 *  - The real chain -- real `duyaAgent`, real driver, real engine, real
 *    Anthropic adapter -- produces a payload the boundary accepts.
 *  - The same payload, with the question moved back behind the rail, is
 *    REPORTED. That second arm is what makes the first one mean something:
 *    a check that cannot fail proves nothing.
 *  - The rail really rode the request, so the claim is about a request that
 *    HAS a rail.
 *
 * ## What it does NOT claim
 *
 * It does not claim the request is CORRECT. It claims the request satisfies
 * the boundary -- the question is there, once, at the end, as a user turn,
 * with no system-attached row behind it. Whether the question is the RIGHT
 * question is the host's business.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. */
const QUESTION = 'PAYLOAD-QUESTION-MARKER';
/** The envelope every system-attached row carries. */
const RAIL_ENVELOPE = 'This context was attached automatically by the system';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** The rows the engine handed to the provider, per request. */
let captured: Message[][] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[]) {
      captured.push(messages);
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

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } =
  await import('./engine-turn-harness.js');

const { initDbClient } = await import('@duya/host/worker-db-client');

// The REAL adapter and the REAL boundary, straight out of the package the
// product ships.
const {
  toAnthropicMessages,
  canonicalizeAnthropicPayload,
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
let workspaceDir = '';
let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;

/**
 * Answer the DB actions a turn reaches for.
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
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string; payload?: { messages?: unknown[] } };
    if (req?.type !== 'db:request') return true;
    if (
      req.action !== 'mailbox:claimBatch' &&
      req.action !== 'message:append' &&
      req.action !== 'journal:emit' &&
      req.action !== 'modeState:get'
    ) {
      throw new Error(`unexpected db action in the payload-invariant proof: ${req.action}`);
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
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'payload-invariants');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-payload-invariants-'));
});

afterEach(() => {
  process.send = realSend;
  cleanupEngineTurnDirs();
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // A temp dir nobody claimed is not a test failure.
  }
});

/** The payload the Anthropic adapter produces for the given rows. */
function payloadFor(rows: Message[]): unknown {
  return toAnthropicMessages(rows, ANTHROPIC_MODEL);
}

describe('the payload the model reads', () => {
  it('ends with the question, with the rail in front of it', async () => {
    installDbIpc();
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-payload-invariants',
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });
    agent.setMessages([
      { id: 'prior-1', role: 'user', content: 'earlier question', timestamp: Date.now() },
    ] as never);

    await driveTurn(agent, QUESTION, {
      options: { sessionId: 's-payload-invariants', clientMsgId: 'client-msg-1' } as never,
    });

    // Non-vacuity FIRST: a request that carried nothing would satisfy
    // nothing, so the check below has to have something to check.
    expect(captured.length).toBeGreaterThan(0);
    const rows = captured[0]!;
    expect(rows.length).toBeGreaterThan(0);

    // The rail really rode this request -- otherwise the claim below would
    // be about a request that happens to have no context in it.
    const railRows = rows.filter(
      (row) =>
        typeof row.content === 'string'
          ? row.content.includes(RAIL_ENVELOPE)
          : JSON.stringify(row.content).includes(RAIL_ENVELOPE),
    );
    expect(railRows.length).toBeGreaterThan(0);

    // The claim, on the payload the adapter actually produces.
    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(payloadFor(rows)),
      { question: QUESTION },
    );

    expect(violations).toEqual([]);
  });

  it('is REPORTED when the question sits behind the rail again', async () => {
    installDbIpc();
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-payload-regressed',
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });

    await driveTurn(agent, QUESTION, {
      options: { sessionId: 's-payload-regressed', clientMsgId: 'client-msg-2' } as never,
    });

    const rows = captured[0]!;

    // The counter-example: the SAME real rows, with the question moved back
    // BEHIND the rail -- the shape the defect took. The boundary has to
    // report it, or the arm above proves nothing.
    const questionIndex = rows.findIndex((row) =>
      String(row.content).includes(QUESTION),
    );
    expect(questionIndex).toBeGreaterThanOrEqual(0);

    // The first row the system attached. The question goes in front of it.
    const railIndex = rows.findIndex((row) =>
      String(row.content).includes(RAIL_ENVELOPE),
    );
    expect(railIndex).toBeGreaterThanOrEqual(0);

    const regressed = [
      ...rows.slice(0, railIndex),
      rows[questionIndex]!,
      ...rows.slice(railIndex, questionIndex),
      ...rows.slice(questionIndex + 1),
    ];

    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(payloadFor(regressed)),
      { question: QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.code)).toContain('QUESTION_NOT_LAST');
  });
});
