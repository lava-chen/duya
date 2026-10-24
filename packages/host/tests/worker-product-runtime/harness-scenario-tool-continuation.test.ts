/**
 * Scenario 2 of the harness's own regression suite: the TOOL CONTINUATION.
 *
 * ## What this file claims
 *
 * The boundary's "the request ends with the question" rule has ONE named
 * exception, and this file is about it: a LATER turn of a run does not carry
 * the prompt at all. Turn 2 is a continuation after a tool result -- the
 * question is history now, and what the model has to react to is the tool
 * result. A prompt re-sent every turn is how a conversation teaches a model
 * to repeat itself.
 *
 * So the claim here is NOT "the question is last". It is:
 *
 *  - the question is carried EXACTLY ONCE (the engine's own copy is not
 *    re-sent on top of the host's transcript row), and
 *  - the tool result stays ADJACENT to the call that produced it, because a
 *    result the model cannot tie to its call is a result it cannot use.
 *
 * ## The chain that is actually driven
 *
 *   real `duyaAgent` -> real `driveRunWithEngine` -> real `RunEngineImpl` ->
 *   real host projection -> real `ToolRegistry` -> the provider client
 *
 * The provider network call is the only fake. The rows the provider client
 * was handed are captured at that seam and the REAL adapter
 * (`toAnthropicMessages`) is run over them, so the assertion is on the merged,
 * reordered wire shape the model reads -- not on the engine's array.
 *
 * ## Every assertion has a counter-example
 *
 * The last arm takes the SAME real turn-2 rows and appends a second copy of
 * the question -- the "the prompt was re-sent" regression -- and asserts the
 * boundary REPORTS it. Without that arm, an assertion that merely counted
 * the question would be a rubber stamp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

/** The user's question. */
const QUESTION = 'TOOL-CONTINUATION-QUESTION-MARKER';
/** What the probe tool hands back. */
const TOOL_MARKER = 'TOOL-CONTINUATION-RESULT-MARKER';
/** The id the model gave its tool call. */
const CALL_ID = 'probe-call-1';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** The rows the provider client was handed, one entry per provider request. */
let captured: Message[][] = [];
/** The frames the scripted provider replays, one script per turn. */
let scripts: readonly (readonly SSEEvent[])[] = [];

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
      throw new Error(`unexpected db action in the tool-continuation scenario: ${req.action}`);
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
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'harness-scenario-tool-continuation');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  captured = [];
  probeRuns = 0;
  probeReturned = null;
  scripts = [
    // Turn one asks for the tool; turn two answers with what came back.
    [{ type: 'tool_use', data: { id: CALL_ID, name: 'probe_tool', input: { value: 'alpha' } } }, DONE],
    [{ type: 'text', data: 'the probe answered' }, DONE],
  ];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-scenario-tool-'));
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

/** Drive the real chain and return the SECOND request's raw rows. */
async function driveToolContinuation(): Promise<Message[]> {
  installDbIpc();

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
    sessionId: 's-harness-scenario-tool',
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  // The tool has to be on the agent's OWN catalog: the engine dispatches
  // through `composeLegacyRunPorts`' lookup, which is derived from
  // `agent.activeMCPRegistry`. A tool advertised from one registry and
  // dispatched out of the other is refused before it runs.
  for (const tool of registry.getAllTools()) {
    agent.activeMCPRegistry.register(tool, registry.getExecutor(tool.name) as never);
  }

  await driveTurn(agent, QUESTION, {
    maxTurns: 6,
    options: { sessionId: 's-harness-scenario-tool', clientMsgId: 'client-msg-tool' } as never,
  });

  expect(captured.length).toBe(2);
  return captured[1]!;
}

/** The payload the REAL Anthropic adapter produces for the given rows. */
function payloadFor(rows: readonly Message[]): PayloadRow[] {
  return toAnthropicMessages(rows as Message[], ANTHROPIC_MODEL) as unknown as PayloadRow[];
}

/** Every text the payload carries, in the order the model would read them. */
function textsOf(payload: readonly PayloadRow[]): string[] {
  return payload.flatMap((row) => row.content.map((block) => block.text ?? ''));
}

describe('a tool continuation does not re-send the question', () => {
  it('carries the question once, and keeps the tool result next to its call', async () => {
    const rows = await driveToolContinuation();
    const payload = payloadFor(rows);

    // ── Non-vacuity FIRST ───────────────────────────────────────────────
    // The tool really ran, exactly once, and returned a marker.
    expect(probeRuns).toBe(1);
    expect(probeReturned).not.toBeNull();

    const texts = textsOf(payload);
    const joined = texts.join('\n');

    // The marker the EXECUTOR returned (source A) is present in the payload
    // the MODEL was sent (source B). A muted tool pipeline calls nothing and
    // feeds back nothing, so this fails there.
    expect(joined).toContain(probeReturned as string);

    // The payload really carries the call and its result.
    const callRow = payload.findIndex(
      (row) => row.role === 'assistant' && row.content.some((block) => block.type === 'tool_use'),
    );
    expect(callRow).toBeGreaterThanOrEqual(0);
    const callId = payload[callRow]!.content.find((block) => block.type === 'tool_use')!.id;
    expect(callId).toBe(CALL_ID);

    // ── The claim ───────────────────────────────────────────────────────
    // The question is carried EXACTLY ONCE. The engine's copy of the prompt
    // is not re-sent on top of the host's transcript row.
    expect(texts.filter((text) => text.includes(QUESTION))).toHaveLength(1);

    // And it is NOT at the end: a later turn is a continuation, and the
    // prompt does not ride it. If the prompt were re-sent, the request would
    // end with the question again.
    expect(texts[texts.length - 1]).not.toContain(QUESTION);

    // The tool result stays ADJACENT to the call that produced it: the row
    // right after the assistant's tool_use row is a user row whose FIRST
    // block is the matching tool_result.
    const resultRow = payload[callRow + 1]!;
    expect(resultRow.role).toBe('user');
    expect(resultRow.content[0]!.type).toBe('tool_result');
    expect(resultRow.content[0]!.tool_use_id).toBe(CALL_ID);
  });

  it('REPORTS the question when the prompt is re-sent on the continuation', async () => {
    const rows = await driveToolContinuation();

    // The counter-example: the SAME real turn-2 rows, with the prompt
    // re-sent at the end -- the regression rule 4 exists to prevent.
    const questionIndex = rows.findIndex((row) => String(row.content).includes(QUESTION));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    const questionRow = rows[questionIndex]!;

    const regressed = [...rows, questionRow];
    const regressedPayload = payloadFor(regressed);

    // The question now rides twice, and the request ends with it.
    const regressedTexts = textsOf(regressedPayload);
    expect(regressedTexts.filter((text) => text.includes(QUESTION))).toHaveLength(2);
    expect(regressedTexts[regressedTexts.length - 1]).toContain(QUESTION);

    // And the boundary says so.
    const violations = checkModelRequest(
      canonicalizeAnthropicPayload(regressedPayload),
      { question: QUESTION },
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.code)).toContain('QUESTION_DUPLICATED');
  });
});
