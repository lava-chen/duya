/**
 * The prompt is the LAST thing the model reads.
 *
 * ## The defect this pins
 *
 * A TUI session sent the user "let's look at the duya ui package -- what do
 * you think of the design?", and the model answered "the user hasn't asked a
 * new question -- this is just system context attached; the last user message
 * was 'continue', which I already answered".
 *
 * The question WAS in the request. The ENGINE had put it FIRST:
 *
 *     [user(question), user(older conversation), user(rail), user(rail)]
 *
 * A model reads a conversation from the end, and every rail row is a `user`
 * turn wrapped in `<system-reminder> ... This context was attached
 * automatically by the system. It is not part of the user's message.` So the
 * newest thing in the request was, by its own text, not the user's message --
 * and the question sat at the far end of a long conversation, looking like
 * ancient history.
 *
 * ## What this file claims
 *
 * The real chain -- real `duyaAgent`, real `driveRunWithEngine`, real engine,
 * real spine -- up to the provider boundary, where a scripted client records
 * the rows it was handed. Three claims, each about a DIFFERENT side of the
 * boundary:
 *
 *  - the question is in the request ONCE (the host's own prompt row and the
 *    run's prompt are one message, reached by two roads);
 *  - it is the LAST row, so it is the newest thing in the request;
 *  - the conversation it belongs to is still in front of it.
 *
 * The rows are compared by CONTENT for the question and by ID for the rest,
 * because the rail rows are minted fresh on every request and their ids are
 * not facts anyone can predict.
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

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

interface ProviderRow {
  readonly role: string;
  readonly id: string | undefined;
  readonly content: string;
}

let rows: ProviderRow[] = [];

/**
 * The scripted provider.
 *
 * The only fake in this file, and it stands in for nothing under test: it
 * records the rows the product handed the provider and then ends the turn.
 */
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

describe('a chat:start turn reaches the provider with the prompt LAST', () => {
  it('sends the question once, at the end, after the conversation it belongs to', async () => {
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

    const questionRows = rows.filter((r) => r.content.includes(QUESTION));
    // Once. The host's own prompt row and the run's prompt are ONE message.
    expect(questionRows).toHaveLength(1);

    // Last. The question is the newest thing in the request, so the model
    // cannot read the request as "context, and nothing new was asked".
    expect(rows.at(-1)?.content).toContain(QUESTION);

    // And the conversation the prompt belongs to is still in front of it.
    const priorIndex = rows.findIndex((r) => r.id === PRIOR_ID);
    expect(priorIndex).toBeGreaterThanOrEqual(0);
    expect(priorIndex).toBeLessThan(rows.length - 1);

    // The rail rides the request as `user` rows that say, in so many words,
    // that they are NOT part of the user's message -- which is exactly why
    // the question has to come after them.
    const railRows = rows.filter((r) => r.content.includes('This context was attached automatically'));
    expect(railRows.length).toBeGreaterThan(0);
    for (const rail of railRows) {
      expect(rows.indexOf(rail)).toBeLessThan(rows.length - 1);
    }
  });
});
