/**
 * Plan 610 S4c-d3 — the sub-agent's turn is driven by the ENGINE.
 *
 * ## What this pins, and what it would have caught
 *
 * `runAgent.ts` used to call `subAgent.streamChat(promptText, options)`, which ran
 * `DuyaAgent`'s own turn generator. That was the third and last production
 * driver of the legacy loop, so this file is what lets boundary gate G7 go green
 * once the loop is deleted.
 *
 * The risk in that flip is NOT "the engine runs" — the engine running is
 * measurable in one assertion. The risk is that it runs DIFFERENTLY, because
 * the engine's only output vocabulary is the PROJECTED legacy `SSEEvent`, and
 * that projection is not shape-compatible with the raw stream the legacy fed
 * `runAgent.ts`'s consumer:
 *
 *   - `text` / `thinking`: projected as `data: { content }`, raw as `data: string`.
 *     Read naively, the sub-agent's returned message would have been the literal
 *     text `{"content":"…"}`.
 *   - `error`: projected as `data: { message, code }`, raw as `data: string`.
 *   - `tool_result`: projected WITHOUT a tool name at all, because
 *     `tool.call_completed` carries none. Read naively, every sub-agent tool
 *     progress row would have reported `toolName: ''`.
 *
 * Each of those is asserted here as an OBSERVABLE, through the real
 * `runAgent(...)` — not through the driver module in isolation — because the
 * claim is about what a caller receives.
 *
 * ## Why the provider is scripted and nothing else is
 *
 * `runAgent` constructs its own `duyaAgent` internally, so a test cannot hand it
 * a double agent: the seams under test (`beginRun`, `beginTurnAssembly`, the real
 * `ToolRegistry`, the real permission gate, the engine's ledger) are all on the
 * class. So the real class runs and only `@duya/ai`'s client factory is
 * replaced — the same construction `headless-run-host-prompt.test.ts` uses, and
 * for the same reason.
 *
 * ## Why the source census is in the same file as the behaviour
 *
 * Because the census is the only assertion that is RED when the flip is undone,
 * and a behaviour-only suite would pass identically on both sides — which is
 * exactly what a parity suite is for, and exactly why it cannot also be the
 * proof that the flip happened. Both are needed; neither substitutes for the
 * other.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolUseContext, Message, SSEEvent } from '../../../types.js';
import type { AgentProgressEvent, SubagentRunDeps } from '../runAgent.js';
import { duyaAgent } from '../../../agent/DuyaAgent.js';
import { createBuiltinRegistry } from '../../builtin.js';

// Plan 610 A5: `runAgent` used to reach these two through module scope; the
// suite now supplies them explicitly. They are the REAL factories, not stubs:
// this suite drives a complete sub-agent turn through the mocked `@duya/ai`
// provider, and the child's tool registry is part of that path (the timing
// notes above measured `createBuiltinRegistry()` at ~19ms for exactly this
// reason).
const subagentDeps: SubagentRunDeps = {
  createSubAgent: (options) => new duyaAgent(options),
  // Argument-less, matching what `runAgent` did before the cut.
  createToolRegistry: () => createBuiltinRegistry(subagentDeps),
};

// ── the scripted provider ────────────────────────────────────────────────────

/** What the MODEL was asked, read from the provider's own mouth. */
const asked: string[] = [];

/**
 * The provider script for one test: a list of event batches, one per model
 * request. The last batch repeats, so an uncapped run still terminates instead
 * of driving the engine forever.
 */
let script: SSEEvent[][] = [];

/**
 * The request counter lives HERE, not inside the `vi.mock` factory.
 *
 * The factory is evaluated once per test FILE, so a `let call = 0` written
 * inside it would survive every test and keep counting: the third test in this
 * file would receive `script[2]` instead of `script[0]` and would silently skip
 * the tool call it was written to exercise. Measured, not theorised — the run
 * that surfaced it reported `toolCalls: 0` for a script whose first batch asks
 * for a tool, and passed when the same test was run alone with `-t`.
 */
const providerState = vi.hoisted(() => ({ call: 0 }));

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: unknown[], options?: Record<string, unknown>) {
      const rows = (messages as { role?: string; content?: unknown }[]).map((m) => ({
        role: m.role ?? '',
        content:
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      }));
      asked.push(rows.map((r) => r.content).join('\n'));
      const batch = script[Math.min(providerState.call, script.length - 1)] ?? [];
      providerState.call += 1;
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of batch) {
          if (signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          yield event;
        }
      })();
    },
  };
  return {
    ...actual,
    createAIClient: () => delegating,
    createAIClientWithRetry: () => delegating,
  };
});

vi.mock('../../../ipc/db-client.js', () => ({
  sessionDb: {
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  },
  messageDb: {
    getBySession: vi.fn(async () => []),
    getCount: vi.fn(async () => 0),
    loadMessages: vi.fn(async () => ({ messages: [] })),
    append: vi.fn(async () => ({ success: true, count: 1 })),
  },
}));

const { runAgent } = await import('../runAgent.js');

/**
 * The builtin registry's module load, hoisted OUT of every test's timed body.
 *
 * `runAgent` calls `await import('../builtin.js')` on every run, and that module
 * statically pulls in ~45 tool implementations — browser automation, computer
 * use, app connectors, the CLI, and their transitive graph. Under Vitest each
 * of those is transformed on demand by Vite rather than bundled, so the FIRST
 * run in this file was the one that paid the whole graph inside its own 10s
 * budget. Measured by timing the phases inside `runAgent`:
 *
 *   case 1  `await import('../builtin.js)` 15301ms of a 15517ms first event
 *   case 2  `await import('../builtin.js')`  5296ms   (the SAME in-flight
 *                                                       promise — case 1 had
 *                                                       timed out and was
 *                                                       abandoned mid-load)
 *   case 3+ `await import('../builtin.js')`     2-4ms
 *
 * Everything else in the same run is single-digit milliseconds, including
 * `createBuiltinRegistry()` (19ms) and `buildSystemPrompt()` (84ms). So the
 * 300x outlier was one module load, paid once, and nothing about it is a
 * retry, a backoff, or a slow-but-correct product path — there is no loop in
 * `runAgent` between `startTime` and the first event that could spin.
 *
 * It is also not a cost production pays: `scripts/build-agent-bundle.mjs`
 * builds the agent with `bundle: true` and externals limited to native and
 * optional packages, so `builtin.ts` is inlined and the dynamic import is a
 * cache hit at runtime.
 *
 * Loading it here instead — at module scope, next to the `runAgent` import
 * that is already there — moves the transform into COLLECTION, which carries
 * no per-test timeout. The run being measured no longer depends on it.
 * Measured after this line: first-event wait 41-108ms for every case, against
 * a 10s budget.
 */
await import('../../builtin.js');

// ── workspace ────────────────────────────────────────────────────────────────

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'duya-subagent-engine-'));
const WORKSPACE = join(TMP_ROOT, 'ws');
mkdirSync(WORKSPACE, { recursive: true });
const TARGET = join(WORKSPACE, 'target.txt');
writeFileSync(TARGET, 'SUBAGENT-PARITY-CANARY', 'utf8');

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

let seq = 0;

function agentDefinition(): never {
  return {
    agentType: 'general-purpose',
    whenToUse: 'test',
    tools: ['*'],
    source: 'custom',
    baseDir: 'custom',
    getSystemPrompt: () => 'role prompt',
  } as never;
}

function context(): ToolUseContext {
  return {
    toolUseId: 'tool-use-1',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      provider: 'anthropic',
      sessionId: 'parent-1',
      workingDirectory: WORKSPACE,
      language: 'en',
      agentDefinitions: { activeAgents: [], allAgents: [agentDefinition()] },
    },
  } as unknown as ToolUseContext;
}

/** Run one sub-agent and hand back everything a caller can observe. */
async function drive(options: {
  script: SSEEvent[][];
  maxTurns?: number;
  ledgerDir?: string;
}): Promise<{
  message: Message;
  progress: AgentProgressEvent[];
  requestedModelCalls: number;
}> {
  asked.length = 0;
  providerState.call = 0;
  script = options.script;
  const progress: AgentProgressEvent[] = [];
  const messages: Message[] = [];
  for await (const message of runAgent({
    agentDefinition: agentDefinition(),
    promptMessages: [{ id: 'p-1', role: 'user', content: 'read the file', timestamp: 0 }],
    toolUseContext: context(),
    isAsync: false,
    availableTools: [],
    agentId: `agent-${(seq += 1)}`,
    createSubAgent: subagentDeps.createSubAgent,
    createToolRegistry: subagentDeps.createToolRegistry,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.ledgerDir === undefined ? {} : { engineLedgerDir: options.ledgerDir }),
    onProgress: (event) => progress.push(event),
  })) {
    messages.push(message);
  }
  const message = messages[messages.length - 1];
  if (message === undefined) throw new Error('runAgent yielded no message');
  return { message, progress, requestedModelCalls: asked.length };
}

/** The concatenated text of the message `runAgent` returns. */
function textOf(message: Message): string {
  return (message.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

const TEXT = 'the sub-agent spoke';
const TOOL_CALL: SSEEvent = {
  type: 'tool_use',
  // `read`, not `Read`: the builtin registry's real name. A tool the run does
  // not declare is refused by `VisibilityGuard` before any dispatch, so a wrong
  // name here would have produced a clean "no tool ran" rather than an error.
  data: { id: 'call-1', name: 'read', input: { file_path: TARGET } },
} as SSEEvent;

// ── the source census: RED when the flip is undone ───────────────────────────

describe('plan 610 S4c-d3 — the sub-agent path drives the engine', () => {
  it('names no legacy turn-loop call, and drives the engine driver exactly once', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../runAgent.ts', import.meta.url), 'utf8');

    // The NEEDLE is assembled rather than written out. Two censuses scan this
    // tree for that call and one of them — `legacy-driver-surface.test.ts` —
    // blanks COMMENTS but not STRING LITERALS, so spelling the call inside this
    // test's own title made the census report this file as a NEW driver of the
    // legacy loop. Measured: it did, and the fix was the title, not the census.
    const NEEDLE = new RegExp('\\.stream' + 'Chat\\s*\\(', 'g');
    const CALLER = new RegExp('\\b' + 'driveSubagentRunWithEngine\\s*\\(', 'g');

    // Comment-stripped, because a mention inside an explanatory comment is
    // documentation and not a driver — and a census that counted comments would
    // have been red from the moment this flip was documented.
    const code = src
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

    expect(code.match(NEEDLE) ?? []).toEqual([]);
    expect(code.match(CALLER) ?? []).toHaveLength(1);
  });
});

// ── observable behaviour: what a caller receives ─────────────────────────────

describe('the engine run reaches the caller in the shape runAgent reads', () => {
  beforeEach(() => {
    asked.length = 0;
  });

  afterEach(() => {
    script = [];
  });

  it('returns the model text verbatim, not a projection of it', async () => {
    const { message } = await drive({
      script: [[{ type: 'text', data: TEXT } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent]],
    });

    // The whole shape argument in one line. `projectToLegacyFrame` sends
    // `text` as `data: { content }`; the legacy read `data` as the string. A
    // sub-agent whose result read `{"content":"the sub-agent spoke"}` would
    // look like a working feature returning JSON, which is why this is asserted
    // on the returned message and not on the event stream.
    expect(textOf(message)).toBe(TEXT);
  });

  it('reports the text to progress as the same string it returned', async () => {
    const { progress } = await drive({
      script: [[{ type: 'text', data: TEXT } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent]],
    });

    const texts = progress.filter((e) => e.type === 'text').map((e) => e.data);
    expect(texts).toContain(TEXT);
  });

  it('carries the tool NAME on the tool_use row and reports the tool_result as the legacy did', async () => {
    const { progress } = await drive({
      script: [
        [
          TOOL_CALL,
          { type: 'result', data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } as SSEEvent,
          { type: 'done', reason: 'tool_use' } as SSEEvent,
        ],
        [{ type: 'text', data: TEXT } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent],
      ],
    });

    const use = progress.find((e) => e.type === 'tool_use');
    const result = progress.find((e) => e.type === 'tool_result');
    expect(use?.toolName).toBe('read');
    // The EMPTY name is the legacy's OWN value, not a regression from this flip.
    // `DuyaAgent._buildToolResultFrame` sets `name: ''` deliberately: "the
    // renderer's `ToolResultInfo` resolves the name from the preceding
    // `tool_use`, and filling it from the record would be a second answer to a
    // question the stream already answered". `projectToLegacyFrame` carries no
    // name either, so this stays `''` on both sides.
    //
    // Asserted rather than left alone because it is the one place where a
    // "helpful" correlation would have made the sub-agent progress row RICHER
    // than it has ever been. That is a product change; pinning `''` is what
    // keeps a future reader from reintroducing it as a bug fix.
    expect(result?.toolName).toBe('');
    // And the tool actually ran, on the engine's own dispatch: the canary file
    // was read.
    expect(result?.toolResult).toContain('SUBAGENT-PARITY-CANARY');
  });

  it('attaches the usage the engine reported', async () => {
    const { message } = await drive({
      script: [
        [
          { type: 'text', data: TEXT } as SSEEvent,
          { type: 'result', data: { input_tokens: 7, output_tokens: 11, total_tokens: 18 } } as SSEEvent,
          { type: 'done', reason: 'end_turn' } as SSEEvent,
        ],
      ],
    });

    expect((message as { token_usage?: { total_tokens?: number } }).token_usage?.total_tokens).toBe(18);
  });

  it('emits a terminal progress event exactly once', async () => {
    const { progress } = await drive({
      script: [[{ type: 'text', data: TEXT } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent]],
    });

    const terminal = progress.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type).toBe('done');
  });

  it('respects `maxTurns`, so an uncapped sub-agent cannot run forever', async () => {
    // Every request asks for a tool, and every call is DISTINCT — a different
    // `toolCallId` and a different file each turn.
    //
    // The distinctness is the whole point, and it was found by mutation rather
    // than designed in. A first version reused one call id and one path, and the
    // `maxTurns` assertion stayed GREEN when the driver call's `maxTurns` was
    // deleted — because the engine's own repeated-call guard ended the run first
    // and the turn ceiling was never reached. A test that cannot tell those two
    // limits apart is not measuring the ceiling, so the script is built to avoid
    // the other limit entirely: with the ceiling in place exactly 2 requests
    // happen, and with it removed the script has 6 more to give.
    const many: SSEEvent[][] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      const path = join(WORKSPACE, `turn-${turn}.txt`);
      writeFileSync(path, `turn-${turn}`, 'utf8');
      many.push([
        {
          type: 'tool_use',
          data: { id: `call-${turn}`, name: 'read', input: { file_path: path } },
        } as SSEEvent,
        { type: 'result', data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } as SSEEvent,
        { type: 'done', reason: 'tool_use' } as SSEEvent,
      ]);
    }

    const capped = await drive({ script: many, maxTurns: 2 });
    expect(capped.requestedModelCalls).toBe(2);

    // And the control: the same script with no ceiling runs further than 2. This
    // is what makes the row above mean "the ceiling stopped it" rather than
    // "something else stopped it at two".
    const uncapped = await drive({ script: many });
    expect(uncapped.requestedModelCalls).toBeGreaterThan(2);
  });
});

// ── the engine's own new on-disk consequence ─────────────────────────────────

describe('a sub-agent run writes the engine tool-side-effect ledger', () => {
  it('creates a ledger directory that did not exist before the run', async () => {
    // Pointed at a path INSIDE a temp root rather than at a `mkdtempSync`
    // directory of its own. That distinction is the whole assertion: a
    // `mkdtempSync` path exists before anything runs, so asserting on its
    // existence proves nothing and would have stayed green with the flip undone.
    const root = mkdtempSync(join(tmpdir(), 'duya-subagent-ledger-'));
    const ledgerDir = join(root, 'engine-ledger');
    try {
      await drive({
        script: [
          [
            TOOL_CALL,
            { type: 'result', data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } as SSEEvent,
            { type: 'done', reason: 'tool_use' } as SSEEvent,
          ],
          [{ type: 'text', data: TEXT } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent],
        ],
        ledgerDir,
      });

      // The engine REFUSES to dispatch anything it cannot ticket, so this ledger
      // is what let the `read` above dispatch at all. Under the legacy loop no
      // ledger was written on this path, so this assertion is RED when the flip
      // is undone — and it is the honest record of a new on-disk consequence
      // rather than a comment claiming one.
      expect(existsSync(ledgerDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});