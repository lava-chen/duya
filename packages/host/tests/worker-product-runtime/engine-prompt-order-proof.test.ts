/**
 * The request ENDS with the question.
 *
 * ## The defect this pins
 *
 * A TUI session sent the user "let's look at the duya ui package -- what do
 * you think of the design?", and the model answered "the user hasn't asked a
 * new question -- this is just system context attached; the last user message
 * was 'continue', which I already answered".
 *
 * The question WAS in the request. It was not the LAST thing in it: the
 * engine had put its own copy of the prompt at the FRONT, ahead of the
 * conversation it was answering, and the host's context rail -- every rail
 * row a `user` turn wrapped in "This context was attached automatically by
 * the system. It is not part of the user's message." -- closed the request.
 *
 * The FIRST version of this file asserted something weaker: that the question
 * was the last thing THE PERSON said, with the system-attached rows allowed
 * to follow it. That assertion passed while the defect was still live,
 * because the system-attached rows ARE `user` rows -- which is exactly what
 * the model reads. This file now asserts the whole request's last row.
 *
 * ## What this file claims
 *
 * The real chain -- real `duyaAgent`, real `driveRunWithEngine`, real engine,
 * real spine -- up to the provider boundary, where a scripted client records
 * the rows it was handed.
 *
 * The claim is about the LAST ROW OF THE REQUEST, not about a filtered view
 * of it. A model reads a conversation from the end, so the last row is the
 * one that decides what it thinks it was asked.
 *
 * ## The three kinds of attached row
 *
 * The host attaches context three ways, and all three land AFTER the prompt
 * in its projection: the volatile-context rail, a hook's block, and an
 * attachment's extracted text. All three are `user` rows. A fix that only
 * moved one of them would leave the defect live for the other two, so the
 * rows are recognised by their own TEXT -- the product's reminder envelope
 * plus a per-source marker -- rather than by an id, because the rail is
 * minted fresh on every request and its ids are not facts anyone can
 * predict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. The provider's rows are searched for it by content. */
const QUESTION = 'PROMPT-QUESTION-MARKER';
/** An earlier question, so the conversation the prompt belongs to is not empty. */
const PRIOR = 'PRIOR-QUESTION-MARKER';
/** The id the host commits the prompt row under. */
const CLIENT_MSG_ID = 'client-msg-1';
/** The id of the earlier row, so the conversation can be found by id. */
const PRIOR_ID = 'prior-user-1';
const SESSION_ID = 's-prompt-order-proof';

/** The envelope every system-attached row is wrapped in. */
const RAIL_ENVELOPE = 'This context was attached automatically by the system';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

interface ProviderRow {
  readonly role: string;
  readonly id: string | undefined;
  readonly content: string;
}

let rows: ProviderRow[] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[]) {
      rows = messages.map((m) => ({
        role: m.role,
        id: m.id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      return (async function* () {
        yield { type: 'text', data: 'ok' };
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

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } = await import('./engine-turn-harness.js');
const { initDbClient } = await import('@duya/host/worker-db-client');

const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;
let workspaceDir = '';

/**
 * Answer the four DB actions this turn reaches for.
 *
 * Under a Vitest pool worker `process.send` is the POOL's channel, so it is
 * replaced and the db-client's own listener is called directly. The journal
 * writes through `message:append` and `journal:emit`, and the turn asks the
 * mailbox for its inter-turn rows.
 */
function installDbIpc(): void {
  if (cachedDbListener === null) {
    initDbClient();
    cachedDbListener = (process
      .listeners('message')
      .filter((l) => !POOL_LISTENERS.has(l))[0] ?? null) as ((m: unknown) => void) | null;
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
      throw new Error(`unexpected db action in the prompt-order proof: ${req.action}`);
    }
    const result =
      req.action === 'mailbox:claimBatch'
        ? { rows: [], claimTokens: [] }
        : req.action === 'message:append'
          ? { success: true, count: req.payload?.messages?.length ?? 0 }
          : { success: true };
    setImmediate(() => dbListener({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

/** The rows the SYSTEM attached, by the envelope it wraps them in. */
function attachedRows(): readonly ProviderRow[] {
  return rows.filter((r) => r.content.includes(RAIL_ENVELOPE));
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'prompt-order-proof');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  rows = [];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-prompt-order-'));
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

describe('a chat:start turn reaches the provider with the question last', () => {
  it('sends the question once, as the request\'s LAST row', async () => {
    installDbIpc();
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: SESSION_ID,
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });
    agent.setMessages([
      { id: PRIOR_ID, role: 'user', content: PRIOR, timestamp: Date.now() },
    ] as never);

    await driveTurn(agent, QUESTION, {
      options: { sessionId: SESSION_ID, clientMsgId: CLIENT_MSG_ID } as never,
    });

    // Once. The host's own prompt row and the run's prompt are ONE message.
    expect(rows.filter((r) => r.content.includes(QUESTION))).toHaveLength(1);

    // And LAST -- the request's last row, not the last row of a filtered
    // view of it. A model reads a conversation from the end, and the
    // system-attached rows are `user` rows too, so "the last thing the person
    // said" is not the same claim as "the last row".
    expect(rows.at(-1)?.content).toContain(QUESTION);

    // The conversation the question belongs to is still in front of it.
    const priorIndex = rows.findIndex((r) => r.id === PRIOR_ID);
    expect(priorIndex).toBeGreaterThanOrEqual(0);
    expect(priorIndex).toBeLessThan(rows.length - 1);

    // And the rail really did ride this request, so the claim above is a
    // claim about a request that HAS a rail -- not about a request that
    // happens to end with the question.
    expect(attachedRows().length).toBeGreaterThan(0);

    // The attached rows are all in FRONT of the question. They are `user`
    // rows, so a request that ends with one of them reads to the model as a
    // turn with no question in it -- which is the defect this file pins.
    const questionIndex = rows.findIndex((r) => r.content.includes(QUESTION));
    const attachedAfter = rows.findIndex(
      (r, index) => index > questionIndex && r.content.includes(RAIL_ENVELOPE),
    );
    expect(attachedAfter).toBe(-1);
  });
});

describe('the request ends with the question in every shape the host can produce', () => {
  it('holds for a turn whose history is empty', async () => {
    // No prior row: the prompt is the ONLY thing the person said, and the
    // rail is the only thing after it. This is the shortest path to the
    // defect, so it is the one that must not regress.
    installDbIpc();
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: `${SESSION_ID}-empty`,
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });

    await driveTurn(agent, QUESTION, {
      options: { sessionId: `${SESSION_ID}-empty`, clientMsgId: CLIENT_MSG_ID } as never,
    });

    expect(rows.filter((r) => r.content.includes(QUESTION))).toHaveLength(1);
    expect(rows.at(-1)?.content).toContain(QUESTION);
  });

  it('holds for a turn whose history already has an assistant reply', async () => {
    // The realistic shape: a question, the model's answer, and then the next
    // question. The prompt must still end the request.
    installDbIpc();
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: `${SESSION_ID}-replied`,
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });
    agent.setMessages([
      { id: PRIOR_ID, role: 'user', content: PRIOR, timestamp: Date.now() },
      { id: 'prior-assistant-1', role: 'assistant', content: 'here is what I found', timestamp: Date.now() },
    ] as never);

    await driveTurn(agent, QUESTION, {
      options: { sessionId: `${SESSION_ID}-replied`, clientMsgId: CLIENT_MSG_ID } as never,
    });

    expect(rows.filter((r) => r.content.includes(QUESTION))).toHaveLength(1);
    expect(rows.at(-1)?.content).toContain(QUESTION);
  });
});
