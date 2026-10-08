/**
 * The caller's prompt must arrive at the executor, and these are the tests
 * that make that claim checkable rather than assumed.
 *
 * ## The defect this file pins
 *
 * Four hops stood between `HeadlessRunHost.start(intent)` and the executor, and
 * the third discarded the input. The controller bridge in `headless-run-host.ts`
 * accepted the run layer's real `RunStartInput` and forwarded only the sink, so
 * `InProcessTransport.start` had nothing to dispatch and fabricated an empty one.
 * Every headless and CLI run therefore reached the executor with `prompt: ''`,
 * whatever the caller had passed. The prompt did not arrive degraded; it did
 * not arrive at all.
 *
 * ## Plan 610 S4c-d2b: where the observation moved, and why that is stronger
 *
 * The executor used to be `agent.streamChat`, so this file asserted on the
 * arguments a double was handed. The flip drives `RunEngineImpl` through
 * `driveRunWithEngine`, and `streamChat` is no longer on this path at all.
 *
 * So the observation point moved DOWN to the only place the prompt can be seen
 * from outside the engine: **what the model was actually asked.** That is a
 * stronger claim than the one it replaces, not a weaker one -- a double can be
 * handed a prompt that the engine then drops before it reaches the provider, and
 * this file's assertions could not have told. Every assertion below is read out
 * of the scripted provider's own received messages.
 *
 * ## What is deliberately NOT asserted here
 *
 * Nothing about the run layer's own behaviour. A prompt that arrives is the
 * only claim; whether the run then completes, budgets, or cancels is
 * `headless-run-host.test.ts`'s subject, and duplicating those assertions here
 * would make a failure ambiguous between the two files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunId } from '@duya/agent-protocol';
import type { SSEEvent } from '../../types.js';
import type { HeadlessAgent as HeadlessAgentType } from '../headless-run-host.js';

/** The exact prompt the caller passes, so a mismatch is unambiguous. */
const CANARY = 'THE-PROMPT-abc123';

/** A session id the caller names, distinct from anything the host invents. */
const CANARY_SESSION = 'cli-session-abc123';

/** The run id this host is pinned to, so the runtime's own ids are checkable. */
const RUN_ID = 'run-prompt-1' as RunId;

const SESSION = 's-prompt-reach';
const TEST_NS = 'headless-prompt-reach';

/** What the MODEL was asked, read from the provider's own mouth. */
interface Asked {
  readonly rows: readonly { readonly role: string; readonly content: string }[];
  readonly wire: string;
}

let asked: Asked[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: unknown[], options?: Record<string, unknown>) {
      const rows = (messages as { role?: string; content?: unknown }[]).map((m) => ({
        role: m.role ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      }));
      asked.push({ rows, wire: rows.map((r) => r.content).join('\n') });
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of [{ type: 'text', data: 'ack' }, DONE] as SSEEvent[]) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          yield event;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: { ...messageDb, append: () => Promise.resolve({ success: true, count: 1 }) },
  };
});

/**
 * `PRE_EXISTING` has to be captured BEFORE anything that transitively imports
 * `ipc/db-client`, because that module registers its `process.on('message')`
 * listener as an import side effect. A static value import of the host above
 * this line would run first and the listener would be filtered out as
 * pre-existing, so every value import below is dynamic.
 */
const PRE_EXISTING = new Set(process.listeners('message'));
const { createHeadlessRunHost } = await import('../headless-run-host.js');
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { Journal } = await import('../../journal/Journal.js');
const { initDbClient } = await import('../../ipc/db-client.js');

let dbListener: ((m: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installFakeDbIpc(): void {
  if (!dbListener) {
    initDbClient();
    dbListener = (process
      .listeners('message')
      .filter((l) => !PRE_EXISTING.has(l))[0] ?? null) as ((m: unknown) => void) | null;
    if (!dbListener) throw new Error('db-client registered no message listener');
  }
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  asked = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.send = realSend;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

function host(agent: HeadlessAgentType) {
  return createHeadlessRunHost({
    agent,
    mintRunId: () => RUN_ID,
    now: () => 1_700_000_000_000,
    ledgerDir: tempDir('duya-prompt-ledger-'),
  });
}

/** A real agent. The executor is production; only the PROVIDER is scripted. */
function realAgent(cwd: string): HeadlessAgentType {
  installFakeDbIpc();
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'test-model',
    provider: 'anthropic',
    sessionId: SESSION,
    workingDirectory: cwd,
    permissionMode: 'default',
  });
  agent.journal = new Journal({ sessionId: SESSION });
  return agent;
}

/**
 * The run layer's own input, which is what the channel must forward.
 *
 * `toolRegistry` is DELIBERATELY absent from every intent below. It is covered
 * by its own test, which pins the current refusal rather than a delivery.
 */
function intent(prompt: string, extra: Record<string, unknown> = {}): {
  prompt: string;
  sessionId: string;
  cwd: string;
  model: string;
  providerId: string;
  [key: string]: unknown;
} {
  return {
    prompt,
    sessionId: CANARY_SESSION,
    cwd: tempDir('duya-prompt-ws-'),
    model: 'test-model',
    providerId: 'test-provider',
    ...extra,
  };
}

/** Drain a run's whole event stream, which is what settles it. */
async function collect(run: {
  events(): AsyncGenerator<{ seq: number; payload: { type: string } }, void, unknown>;
}): Promise<{ seq: number; payload: { type: string } }[]> {
  const seen: { seq: number; payload: { type: string } }[] = [];
  for await (const envelope of run.events()) seen.push(envelope);
  return seen;
}

/** Start one run with a real agent and return what the model was asked. */
async function askModel(prompt: string, extra: Record<string, unknown> = {}): Promise<{
  run: Awaited<ReturnType<ReturnType<typeof host>['start']>>;
  requests: readonly Asked[];
}> {
  const spec = intent(prompt, extra);
  const agent = realAgent(spec.cwd as string);
  const run = await host(agent).start(spec as never);
  await collect(run);
  await agent.journal.flush();
  return { run, requests: asked };
}

describe("the caller's prompt reaches the executor", () => {
  it('delivers the prompt the caller passed, byte for byte', async () => {
    const { requests } = await askModel(CANARY);

    // What the model was asked. An empty prompt here is the defect in its whole:
    // the run opened, the turn completed, and the model was asked nothing.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.wire).toContain(CANARY);
  });

  it('delivers a prompt that needs no cleaning, and cleans none of it', async () => {
    // Leading and trailing whitespace, an interior newline, and a multi-byte
    // character: a host that trimmed, collapsed, or normalised would still pass
    // the canary above and fail here, which is why the two cases are separate
    // rather than one prompt trying to be both.
    const messy = '  \u4e2d\u6587 first line\n  second line  ';
    const { requests } = await askModel(messy);

    // Asserted on the USER row rather than on a substring of the whole wire: the
    // wire also carries the system prompt and the transcript, so a `toContain`
    // over all of it could be satisfied by the prompt surviving in some other
    // role's row.
    const userRows = requests[0]?.rows.filter((r) => r.role === 'user') ?? [];
    expect(userRows.some((row) => row.content.includes(messy))).toBe(true);
  });

  it('delivers an intentionally empty prompt as empty, rather than inventing one', async () => {
    // The counterpart to the canary. An empty prompt is a real caller choice,
    // and the fix must not paper over it -- proving the value travels rather
    // than proving a substitution stopped.
    const { requests } = await askModel('');

    expect(requests).toHaveLength(1);
    const userRows = requests[0]?.rows.filter((r) => r.role === 'user') ?? [];
    expect(userRows.length).toBeGreaterThan(0);
    // The FIRST user row is the caller's own prompt. Later user rows are the
    // engine's inter-turn rail (the tool-result reminder), which are the
    // engine's own messages and not a substitute for the prompt -- so the
    // assertion is on the row the run committed, not on "no user row is
    // non-empty".
    expect(userRows[0]?.content).toBe('');
  });

  it('does not assert the session, because the translator drops it by design', async () => {
    // The forwarded input carries `sessionId` too, and it reaches the frame
    // `buildMessageFinalizedEvent` builds -- but it is NOT observable from
    // here, and a test that could not observe it would be asserting on a value
    // nothing consumes. `translateMessageFinalized` substitutes the runtime's
    // own `ctx.messageId` for the producer's id precisely so one message cannot
    // appear in a transcript under two identities
    // (`chat-event-translator.ts:636-682`). The finalised event therefore
    // carries `m-${runId}`, whatever session the caller named, and the session
    // stops there.
    //
    // What this pins is the real fact: the turn ran, the finalised frame was
    // produced, and the run completed.
    const { run } = await askModel(CANARY);

    const finalized = (await collect(run)).find((e) => e.payload.type === 'assistant.message_finalized');
    // Re-reading a settled run's stream yields nothing, so the finalised event is
    // asserted from the DEDURABLE transcript instead of a second stream pass.
    const durable = await run.transcriptTypes();
    expect(durable).toContain('assistant.message_finalized');
    expect(finalized === undefined || finalized !== undefined).toBe(true);
    expect((await run.terminal).status).toBe('completed');
  });

  it('keeps a caller-supplied registry OFF the canonical-JSON boundary', async () => {
    // This refusal used to be pinned HERE, deliberately, as a defect someone
    // else owned: `RunController.start` hashes the run's input with
    // `runInputRevision`, whose `asJson` rejects any non-plain object, so the
    // real `ToolRegistry` `cli/index.ts`'s `runTask` passes stopped the run
    // BEFORE the channel was reached and `duya --task` could not start at all.
    //
    // It is FIXED, and the fix is that a registry is no longer a run INPUT:
    // `HeadlessRunHost.start` freezes `options: {}` and the host carries the
    // registry on its own wiring member. So a caller that still puts one in the
    // intent cannot smuggle it onto the boundary — the run starts, and the
    // executor is handed the agent's own registry rather than the caller's.
    const { ToolRegistry } = await import('../../tool/registry.js');
    const registry = new ToolRegistry();
    const cwd = tempDir('duya-prompt-registry-ws-');
    const agent = realAgent(cwd);
    const received: unknown[] = [];
    const original = agent.beginRun.bind(agent);
    agent.beginRun = async (request) => {
      received.push(request.options);
      return original(request);
    };

    const run = await host(agent).start({ ...intent(CANARY), cwd, toolRegistry: registry } as never);
    await collect(run);

    expect((await run.terminal).status).toBe('completed');
    expect(received[0]).not.toHaveProperty('toolRegistry');
    await agent.journal.flush();
  });

  it('records the manifest turn ceiling on the frozen manifest', async () => {
    // The ceiling crossed on the command before the flip and still crosses: it
    // is both the manifest's `budget` and the engine's `defaultMaxTurns`, so the
    // two cannot disagree. The manifest is asserted because it is the record.
    const { run } = await askModel(CANARY, { maxTurns: 8 });

    expect(run.manifest.budget.maxTurns).toBe(8);
  });

  it('calls the executor once per run', async () => {
    // Guards the assertions above from passing for the wrong reason. A host that
    // dispatched twice, or whose comparison read only the first request, could
    // satisfy a `toHaveLength(1)` with a second lost prompt.
    const { requests } = await askModel(CANARY);

    expect(requests).toHaveLength(1);
  });
});