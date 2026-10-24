/**
 * Scenario 3 of the harness's own regression suite: STEERING MID-RUN.
 *
 * ## What this file claims
 *
 * The host may inject text into a run that is already going -- a mailbox row
 * the user sent while the agent was working. The injection rides the NEXT
 * request, and that request is NOT the first turn of the run.
 *
 * Two things have to hold, and both are about the FINAL payload:
 *
 *  - the injection does not CORRUPT the ordering. The conversation's own
 *    rows keep their order, the tool result stays next to its call, and the
 *    injected text -- being the newest thing the model has to react to --
 *    rides LAST.
 *  - the injection does not DUPLICATE the question. The question is carried
 *    exactly once, where the conversation already put it.
 *
 * ## The injection is a real one
 *
 * The steering text arrives the way it arrives in production: the host claims
 * a MAILBOX row over the worker IPC at the run's `before_model_turn`
 * checkpoint, and the agent projects it into a runtime-context row. The fake
 * DB channel below hands the row over on the SECOND `before_model_turn`
 * claim, which is turn 2 -- so the injection really lands on a request that
 * is not the first turn of the run, and the first arm asserts that it did.
 *
 * ## The chain that is actually driven
 *
 *   real `duyaAgent` -> real `driveRunWithEngine` -> real `RunEngineImpl` ->
 *   real host projection -> real `ToolRegistry` -> the provider client
 *
 * The provider network call is the only fake. The rows the provider client
 * was handed are captured at that seam and the REAL adapter
 * (`toAnthropicMessages`) is run over them.
 *
 * ## Every assertion has a counter-example
 *
 * Two arms at the bottom take the SAME real rows and rebuild the two shapes
 * the boundary exists to forbid -- the injected text moved to the FRONT, and
 * the question sent TWICE -- and assert the boundary REPORTS them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. */
const QUESTION = 'STEERING-QUESTION-MARKER';
/** The text the host injects mid-run. */
const STEERING = 'STEERING-INJECTION-MARKER';
/** What the probe tool hands back. */
const TOOL_MARKER = 'STEERING-TOOL-RESULT-MARKER';
/** The id the model gave its tool call. */
const CALL_ID = 'probe-call-1';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** The rows the provider client was handed, one entry per provider request. */
let captured: Message[][] = [];
/** The frames the scripted provider replays, one script per turn. */
let scripts: readonly (readonly SSEEvent[])[] = [];
/** How many `before_model_turn` mailbox claims the run has made. */
let modelTurnClaims = 0;

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
      const script = scripts[Math.min(captured.length - 1, scripts.length - 1)] ?? [DONE];
      return (async function* () {
        for (const event of script) yield event;
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
const { ToolRegistry } = await import('@duya/host/worker-tool-registry');

const { toAnthropicMessages } = await import('@duya/ai/clients');
const { canonicalizeAnthropicPayload, checkModelRequest } = await import('@duya/ai');

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

/** How many times the probe tool actually ran. */
let probeRuns = 0;
/** What the probe tool handed back on its last run. */
let probeReturned: string | null = null;

/**
 * The mailbox row the host claims mid-run.
 *
 * The shape is the RAW row the worker bridge delivers, because that is what
 * the agent's claim reads: `kind` decides which adapter projects it, and the
 * claim token is what makes it usable at all.
 */
function steeringMailboxRow(sessionId: string): Record<string, unknown> {
  return {
    id: 'mailbox-row-1',
    session_id: sessionId,
    submitted_during_run_id: 'run-1',
    content: STEERING,
    kind: 'queued',
    status: 'pending',
    priority: 0,
    constraints_json: null,
    attachments_json: null,
    source: 'user',
    client_msg_id: null,
    created_at: Date.now(),
    claim_token: 'mailbox-claim-token-1',
    claim_expires_at: null,
    observed_at: null,
    observed_at_checkpoint: null,
    observed_by_run_id: null,
    injected_run_id: null,
    claim_attempts: 1,
    last_claim_error: null,
    edit_locked_at: null,
    apply_mode: null,
    applied_at: null,
    applied_at_checkpoint: null,
    applied_summary: null,
    resulting_user_msg_id: null,
    failure_reason: null,
    edit_history_json: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
  };
}

/**
 * Answer the DB actions this turn reaches for.
 *
 * The mailbox claim is the interesting one: the steering row is handed over
 * on the SECOND `before_model_turn` claim, which is the run's SECOND turn --
 * so the injection lands on a request that is not the first turn.
 */
function installDbIpc(sessionId: string): void {
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
    const req = msg as {
      type?: string;
      action?: string;
      id?: string;
      payload?: { messages?: unknown[]; checkpoint?: string };
    };
    if (req?.type !== 'db:request') return true;
    if (
      req.action !== 'mailbox:claimBatch' &&
      req.action !== 'mailbox:apply' &&
      req.action !== 'message:append' &&
      req.action !== 'journal:emit' &&
      req.action !== 'modeState:get'
    ) {
      throw new Error(`unexpected db action in the steering scenario: ${req.action}`);
    }
    let result: unknown = { success: true };
    if (req.action === 'mailbox:claimBatch') {
      const isModelTurn = req.payload?.checkpoint === 'before_model_turn';
      if (isModelTurn) modelTurnClaims += 1;
      const rows = isModelTurn && modelTurnClaims === 2 ? [steeringMailboxRow(sessionId)] : [];
      result = { rows, claimTokens: rows.map(() => 'mailbox-claim-token-1') };
    } else if (req.action === 'message:append') {
      result = { success: true, count: req.payload?.messages?.length ?? 0 };
    }
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'harness-scenario-steering');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  modelTurnClaims = 0;
  probeRuns = 0;
  probeReturned = null;
  scripts = [
    [{ type: 'tool_use', data: { id: CALL_ID, name: 'probe_tool', input: { value: 'alpha' } } }, DONE],
    [{ type: 'text', data: 'the probe answered' }, DONE],
  ];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-scenario-steering-'));
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

/** One block of an Anthropic payload row. */
interface PayloadBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly tool_use_id?: string;
  readonly content?: unknown;
}

interface PayloadRow {
  readonly role: string;
  readonly content: PayloadBlock[];
}

/** Drive the real chain and return every provider request's raw rows. */
async function driveSteering(): Promise<Message[][]> {
  const sessionId = 's-harness-scenario-steering';
  installDbIpc(sessionId);

  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'probe_tool',
      description: 'probe that answers with a marker',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async (input: Record<string, unknown>) => {
        probeRuns += 1;
        probeReturned = `${TOOL_MARKER}:${String(input.value ?? '')}`;
        return { id: 'probe-result-1', name: 'probe_tool', result: probeReturned };
      },
    } as never,
  );

  const agent = makeWorkerSession({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  for (const tool of registry.getAllTools()) {
    agent.activeMCPRegistry.register(tool, registry.getExecutor(tool.name) as never);
  }

  await driveTurn(agent, QUESTION, {
    maxTurns: 6,
    options: { sessionId, clientMsgId: 'client-msg-steering' } as never,
  });

  expect(captured.length).toBe(2);
  return captured;
}

/** The payload the REAL Anthropic adapter produces for the given rows. */
function payloadFor(rows: readonly Message[]): PayloadRow[] {
  return toAnthropicMessages(rows as Message[], ANTHROPIC_MODEL) as unknown as PayloadRow[];
}

/** Every text the payload carries, in the order the model would read them. */
function textsOf(payload: readonly PayloadRow[]): string[] {
  return payload.flatMap((row) => row.content.map((block) => block.text ?? ''));
}

describe('steering injected mid-run does not corrupt the request', () => {
  it('rides last, keeps the tool result next to its call, and does not duplicate the question', async () => {
    const requests = await driveSteering();
    const firstRows = requests[0]!;
    const secondRows = requests[1]!;
    const payload = payloadFor(secondRows);
    const texts = textsOf(payload);

    // ── Non-vacuity FIRST ───────────────────────────────────────────────
    // The injection really happened, and it really happened on a request
    // that is NOT the first turn of the run.
    expect(modelTurnClaims).toBeGreaterThanOrEqual(2);
    expect(texts.some((text) => text.includes(STEERING))).toBe(true);
    expect(textsOf(payloadFor(firstRows)).some((text) => text.includes(STEERING))).toBe(false);

    // The tool really ran: the marker the EXECUTOR returned is in the
    // payload the MODEL was sent.
    expect(probeRuns).toBe(1);
    expect(probeReturned).not.toBeNull();
    expect(texts.join('\n')).toContain(probeReturned as string);

    // ── The claim ───────────────────────────────────────────────────────
    // The injected text rides LAST: it is the newest thing the model has to
    // react to, so it is the last thing it reads.
    expect(texts[texts.length - 1]).toContain(STEERING);

    // The injection did not duplicate the question. The question is carried
    // exactly once, in the place the conversation already put it.
    expect(texts.filter((text) => text.includes(QUESTION))).toHaveLength(1);

    // The ordering was not corrupted: the tool result is still adjacent to
    // the call that produced it.
    const callRow = payload.findIndex(
      (row) => row.role === 'assistant' && row.content.some((block) => block.type === 'tool_use'),
    );
    expect(callRow).toBeGreaterThanOrEqual(0);
    const resultRow = payload[callRow + 1]!;
    expect(resultRow.role).toBe('user');
    expect(resultRow.content[0]!.type).toBe('tool_result');
    expect(resultRow.content[0]!.tool_use_id).toBe(CALL_ID);

    // And the injected text is the request's last turn, once, as a user
    // turn -- the boundary applied to the newest instruction of a
    // continuation. (A continuation is not a question turn, so the question
    // itself is not expected to be last; the INJECTION is what the model
    // has to react to now.)
    expect(
      checkModelRequest(canonicalizeAnthropicPayload(payload), { question: STEERING }),
    ).toEqual([]);
  });

  it('REPORTS the injected text when it is moved to the front', async () => {
    const requests = await driveSteering();
    const rows = requests[1]!;

    // The counter-example: the SAME real rows, with the injected row moved
    // to the front of the request -- the shape a corrupted injection takes.
    const steeringIndex = rows.findIndex((row) => String(row.content).includes(STEERING));
    expect(steeringIndex).toBeGreaterThanOrEqual(0);
    const steeringRow = rows[steeringIndex]!;

    const regressed = [
      steeringRow,
      ...rows.slice(0, steeringIndex),
      ...rows.slice(steeringIndex + 1),
    ];

    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(payloadFor(regressed)),
      { question: STEERING },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_NOT_LAST');
  });

  it('REPORTS the question when the injection duplicates it', async () => {
    const requests = await driveSteering();
    const rows = requests[1]!;

    // The counter-example: the SAME real rows, with the question sent a
    // second time at the end of the request. A duplicated question is a
    // conversation that teaches the model to answer twice.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [...rows, questionRow];

    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(payloadFor(regressed)),
      { question: QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_DUPLICATED');
  });
});
