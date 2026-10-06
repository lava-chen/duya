/**
 * Plan 610 A3-2b8 (S2): a per-turn pipeline producible from OUTSIDE the loop.
 *
 * ## What this file is for
 *
 * `buildTurnPipeline` was already public (A3-2b4) and `assembleTurn` already
 * returned a pipeline (A3-2b7), and it was STILL unreachable from outside
 * `streamChat`. The reason is the boring one, and it is the reason a seam is
 * not the same thing as a producer: `assembleTurn`'s request needs the
 * resolved-tools decision, the guarded permission gate and the meta-tool
 * dispatcher, and all three were closure locals of a 2300-line generator.
 * `beginTurnAssembly` is the producer for that request.
 *
 * ## The hazard this slice exists to survive
 *
 * `StreamingToolExecutor.discarded` is a ONE-WAY LATCH. It is never reset, and
 * `discard()` also aborts the sibling controller. So a pipeline that outlives
 * its turn accepts tools, drains nothing, raises no error, and passes every
 * structural test -- the executor simply goes quiet. That failure mode is
 * invisible by construction, which is why the central test here is a
 * CROSS-TURN one: one turn cannot demonstrate it, because the hazard only
 * appears at the turn boundary.
 *
 * ## What the cross-turn test rules out, precisely
 *
 * That after `discard()` on turn 1, turn 2's pipeline still executes a tool
 * and still delivers its result. Concretely it rules out: a handle that memoizes
 * its pipeline; a handle that memoizes the executor behind it; and any future
 * edit that reaches for "reuse the pipeline we already have".
 *
 * It does NOT rule out a discard that is correct -- the whole point is that
 * turn 1's pipeline IS dead after its discard, and `isUsable()` is asserted
 * false to prove the test is not passing because the latch never fired.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, SSEEvent, Tool } from '../../types.js';
import type { ToolExecutionPipeline } from '../../tool/ToolExecutionPipeline.js';

// ============================================================================
// The source under test
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUYA = path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts');

/**
 * Comment-strip before counting.
 *
 * Local rather than the gate's `strip-comments.mjs`, and for the measured
 * reason recorded in `turn-assembly-seam.test.ts`: importing it from a
 * `@duya/agent` test adds a `pkg:agent -> scripts` edge, which moved
 * `architecture:check` 963 -> 964 and the self-test 786 -> 787. The local copy
 * was verified byte-identical to the gate's on `DuyaAgent.ts`, CRLF included.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function code(): string {
  return stripComments(fs.readFileSync(DUYA, 'utf8'));
}

function occurrences(re: RegExp): number {
  return (code().match(new RegExp(re.source, 'g')) ?? []).length;
}

// ============================================================================
// The offline host: scripted provider + fake worker IPC
// ============================================================================

let active: { seen: number } | null = null;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 't1', name: 'probe_ok', input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'done' }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], _options?: Record<string, unknown>) {
      const index = active?.seen ?? 0;
      active = { seen: index + 1 };
      const script = SCRIPTS[Math.min(index, SCRIPTS.length - 1)] ?? SCRIPTS[SCRIPTS.length - 1];
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { initDbClient } = await import('../../ipc/db-client.js');

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

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
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  active = null;
});

// ============================================================================
// The probe tool, and the handle under test
// ============================================================================

interface Probe {
  readonly runs: () => number;
  readonly registry: InstanceType<typeof ToolRegistry>;
}

const PROBE = 'probe_ok';

function probeRegistry(): Probe {
  let runs = 0;
  const registry = new ToolRegistry();
  registry.register(
    {
      name: PROBE,
      description: 'probe that counts its own executions',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async (input: Record<string, unknown>) => {
        runs += 1;
        return { id: String(input.id ?? 'none'), name: PROBE, result: `RAN-${runs}` };
      },
    } as never,
  );
  return { registry, runs: () => runs };
}

let sessionSeq = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionSeq += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-turn-pipeline-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

/**
 * Stand in for a live run: `streamChat` normally establishes the abort
 * controller that `buildTurnPipeline` requires, and it is private, so the cast
 * is the honest boundary. Stated rather than hidden.
 */
function armRun(agent: InstanceType<typeof duyaAgent>): void {
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();
}

async function openHandle(
  agent: InstanceType<typeof duyaAgent>,
  registry: InstanceType<typeof ToolRegistry>,
  publisher?: unknown,
): Promise<Awaited<ReturnType<InstanceType<typeof duyaAgent>['beginTurnAssembly']>>> {
  armRun(agent);
  const options = { toolRegistry: registry, sessionId: 'handle-test' };
  const turnContext = agent.assembleTurnContext(
    options as never,
    'run the probe',
  );
  return agent.beginTurnAssembly({
    options: options as never,
    prompt: 'run the probe',
    appliedProfile: undefined,
    turnContext,
    publisher: publisher as never,
  });
}

/**
 * Mirror `runTurnStream`'s order: refresh the declared set, THEN open the
 * request, THEN queue and drain.
 *
 * The refresh is not incidental. The guard starts with an EMPTY declared set
 * and denies any tool outside it, so a test that skipped this would see a
 * `tool_error` for every call and could "pass" a mute-pipeline assertion by
 * never dispatching anything. `assertRan` below is what stops that.
 */
async function runOneTool(
  handle: { refreshDeclaredTools: () => Set<string> },
  pipeline: ToolExecutionPipeline,
  id: string,
): Promise<string[]> {
  handle.refreshDeclaredTools();
  pipeline.addTool({ id, name: PROBE, input: { id } });
  const texts: string[] = [];
  for await (const update of pipeline.getRemainingResults()) {
    const message = (update as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

// ============================================================================
// 1. THE ACCEPTANCE TEST: two turns, tools still work after a discard
// ============================================================================

describe('a per-turn pipeline survives the previous turn\'s discard', () => {
  it('still dispatches and drains on turn 2 after turn 1 was discarded', async () => {
    installFakeDbIpc();
    const probe = probeRegistry();
    const agent = makeAgent();
    const handle = await openHandle(agent, probe.registry);

    const turn1 = handle.assemble({
      turn: 1,
      systemPrompt: handle.systemPrompt,
      messages: [],
      tools: handle.tools as Tool[],
    });

    // Turn 1 really works, so a later failure cannot be blamed on a fixture
    // that never dispatched anything.
    expect(turn1.pipeline.isUsable()).toBe(true);
    const first = await runOneTool(handle, turn1.pipeline, 't1');
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('RAN-1');
    expect(probe.runs()).toBe(1);

    // The model-retry path. `discarded` is a one-way latch, so this pipeline is
    // finished -- and asserting it is dead is what proves the rest of the test
    // is measuring the SECOND pipeline rather than a pipeline that never latched.
    turn1.pipeline.discard();
    expect(turn1.pipeline.isUsable()).toBe(false);

    const turn2 = handle.assemble({
      turn: 2,
      systemPrompt: handle.systemPrompt,
      messages: [],
      tools: handle.tools as Tool[],
    });

    // The BEHAVIOURAL claim leads, deliberately: the observable symptom of the
    // hazard is a mute executor, not a shared object identity. Asserting
    // `not.toBe` first would report "same object" when a held pipeline is the
    // defect, and that is a structural fact -- it would pass for a
    // memoization that had no visible consequence. Running the tool first means
    // a regression here fails on "the tool did not run", which is the failure
    // that would actually reach a user.
    const second = await runOneTool(handle, turn2.pipeline, 't2');
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('RAN-2');
    // The tool REALLY ran a second time. This is the assertion a mute executor
    // cannot satisfy: it accepts the call, drains nothing, and reports nothing.
    expect(probe.runs()).toBe(2);

    // And the structural half, supporting the behavioural half: a DIFFERENT
    // pipeline, still usable, while turn 1's is a different dead object.
    expect(turn2.pipeline).not.toBe(turn1.pipeline);
    expect(turn2.pipeline.isUsable()).toBe(true);
  });

  it('gives every turn its own pipeline across three turns, not just two', async () => {
    // The hazard needs a boundary to appear, and one boundary is the minimum.
    // Three turns also pins that the handle is not simply alternating two
    // instances.
    const probe = probeRegistry();
    const agent = makeAgent();
    const handle = await openHandle(agent, probe.registry);

    const pipelines = [1, 2, 3].map((turn) =>
      handle.assemble({
        turn,
        systemPrompt: handle.systemPrompt,
        messages: [],
        tools: handle.tools as Tool[],
      }).pipeline,
    );

    expect(new Set(pipelines).size).toBe(3);
    // Discard the EARLIER turns only. Discarding all three and then expecting
    // the third to be usable would be asserting a contradiction, and a test
    // that cannot fail proves nothing.
    pipelines[0].discard();
    pipelines[1].discard();
    expect(pipelines.slice(0, 2).every((p) => !p.isUsable())).toBe(true);
    expect(pipelines[2].isUsable()).toBe(true);

    const after = await runOneTool(handle, pipelines[2], 't3');
    expect(after).toHaveLength(1);
    expect(probe.runs()).toBe(1);
  });
});

// ============================================================================
// 2. The handle is reachable, and there is only one of it
// ============================================================================

describe('the run handle is public, and the loop routes through it', () => {
  it('declares beginTurnAssembly without a `private` modifier', () => {
    expect(code()).toContain('beginTurnAssembly(request: RunAssemblyRequest): Promise<RunTurnAssembly>');
    expect(code()).not.toMatch(/private\s+beginTurnAssembly/);
  });

  it('keeps ONE pipeline surface: one construction, one factory caller, one assembly caller', () => {
    // A second construction site is a second answer to "what is this turn's
    // pipeline", and two answers can disagree. Counted, not pattern-matched.
    expect(occurrences(/new ToolExecutionPipeline\s*\(/)).toBe(1);
    expect(occurrences(/this\.buildTurnPipeline\s*\(/)).toBe(1);
    expect(occurrences(/this\.assembleTurn\s*\(/)).toBe(1);
    expect(occurrences(/this\.beginTurnAssembly\s*\(/)).toBe(1);
  });

  it('builds the run-scoped pieces exactly once each', () => {
    // Each of these was a closure local of the generator. Two constructions is
    // two accounts of one run's decision.
    expect(occurrences(/this\._resolveTools\s*\(/)).toBe(1);
    expect(occurrences(/buildPermissions\s*\(/)).toBe(1);
    expect(occurrences(/createToolInvokeDispatcherFromRegistry\s*\(/)).toBe(1);
    expect(occurrences(/evaluateVisibilityGuard\s*\(/)).toBe(1);
  });

  it('does not rebuild the turn context it was handed', () => {
    // The handle ASSEMBLES no turn context: `streamChat` already did, ~36 reads
    // earlier, and a handle building its own would be a second
    // `TurnAssembler.build` for one run. One construction, and it is not here.
    expect(occurrences(/this\.assembleTurnContext\s*\(/)).toBe(1);
    expect(code()).toContain('const turnContext = this.assembleTurnContext(options, prompt);');
  });

  it('leaves the entry driving the legacy loop', () => {
    // S2 is not a driver change and must not become one. The entry still calls
    // `streamChat` exactly once and still constructs no engine.
    const entry = stripComments(
      fs.readFileSync(path.join(HERE, '..', 'agent-process-entry.ts'), 'utf8'),
    );
    expect((entry.match(/agent\.streamChat\s*\(/g) ?? []).length).toBe(1);
    expect((entry.match(/new RunEngineImpl\s*\(/g) ?? []).length).toBe(0);
  });
});

// ============================================================================
// 3. The handle hands out the run's own decisions
// ============================================================================

describe('the handle exposes the run\'s decisions, and refreshes what moves per request', () => {
  it('re-snapshots the declared tools from the surface the turn was assembled with', async () => {
    const probe = probeRegistry();
    const agent = makeAgent();
    const handle = await openHandle(agent, probe.registry);

    handle.assemble({
      turn: 1,
      systemPrompt: handle.systemPrompt,
      messages: [],
      tools: handle.tools as Tool[],
    });
    const first = handle.refreshDeclaredTools();
    expect(first.has(PROBE)).toBe(true);
    // The set is a SNAPSHOT, replaced rather than mutated: the guard reads the
    // current one, so a caller that appended to a stale set would widen the
    // guard for a request it is no longer opening.
    expect(handle.refreshDeclaredTools()).not.toBe(first);

    // Promotion: a surface that gained a tool is what the next request
    // declares, because the snapshot comes from the last ASSEMBLED turn.
    const promoted = [...(handle.tools as Tool[]), { name: 'later_tool', description: '', input_schema: {} } as Tool];
    handle.assemble({
      turn: 2,
      systemPrompt: handle.systemPrompt,
      messages: [],
      tools: promoted,
    });
    const second = handle.refreshDeclaredTools();
    expect(second.has('later_tool')).toBe(true);
    expect(second.has(PROBE)).toBe(true);
  });

  it('advances the catalog round per assembled turn, on the run\'s own view', async () => {
    const probe = probeRegistry();
    const agent = makeAgent();
    const handle = await openHandle(agent, probe.registry);
    const view = handle.resolved.catalogView;

    handle.assemble({ turn: 1, systemPrompt: handle.systemPrompt, messages: [], tools: handle.tools as Tool[] });
    expect(view.currentRound).toBe(1);
    handle.assemble({ turn: 2, systemPrompt: handle.systemPrompt, messages: [], tools: handle.tools as Tool[] });
    expect(view.currentRound).toBe(2);
    // The handle does not fork the view per turn: the meta-tool dispatcher
    // closes over ONE object and reads it on every `tool_invoke`.
    expect(handle.resolved.catalogView).toBe(view);
  });
});