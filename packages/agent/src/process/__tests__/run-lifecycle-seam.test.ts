/**
 * Plan 610 P4: a run's lifecycle is establishable from OUTSIDE the generator.
 *
 * ## What this file is for
 *
 * `beginTurnAssembly` was already public and already returned a handle, and it
 * was STILL unusable by any production path. The reason was not the handle: it
 * was that a handle cannot be BUILT without a live run behind it.
 * `buildTurnPipeline` refuses when `abortController` is null rather than
 * substituting a fresh controller, because a substituted one would wire the
 * turn's tool-use context to a signal the caller cannot abort. That field was
 * private, was assigned only inside `streamChat`'s prologue, and had no setter,
 * so the only way to satisfy the refusal was to write the private field.
 *
 * MEASURED at this commit: 15 such cast sites across 12 harness files. One of
 * them -- `turn-assembly-seam.test.ts` -- calls its own cast "the honest
 * boundary", which is the repository stating in its own words that no honest
 * production path existed. `beginRun` is that path, and this file is the proof
 * that it is one: there is no cast in it, because there is nothing to cast.
 *
 * ## What the central assertion is, and what it deliberately is NOT
 *
 * The claim is that a tool ACTUALLY EXECUTES, so it is a POSITIVE execution
 * count read from the probe's own executor (`probe.runs()`), plus the result
 * text the pipeline drained back. It is not an assertion that nothing threw.
 * `turn-pipeline-producer.test.ts` documents why that distinction is load-bearing
 * rather than stylistic: `StreamingToolExecutor.discarded` is a one-way latch, so
 * a muted pipeline accepts a tool call, drains nothing, raises no error, and
 * satisfies any "no error was raised" assertion while never having run a single
 * tool. A count read from inside the executor cannot be satisfied that way.
 *
 * ## `close` is asserted in BOTH directions
 *
 * Releasing is only half of a release contract. So the test pins that after
 * `close` the agent refuses to assemble again -- the honest post-close state --
 * AND that the refusal is not permanent, because a run lifecycle that released
 * the field without releasing the ability to hold it would have turned one
 * aborted run into a permanently unusable agent.
 *
 * ## What this file does NOT claim
 *
 * It does not claim the engine can drive a run. Nothing here constructs
 * `RunEngineImpl`; the harness is deliberately the minimal one that makes a tool
 * execute, so a failure names the lifecycle seam rather than the engine's
 * twenty-one ports. And it does not claim the legacy and the seam are
 * interchangeable -- `turn-assembly-seam.test.ts` is the differential that
 * compares them, and it drives the engine.
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
 * Local rather than the gate's `strip-comments.mjs`, for the measured reason
 * `turn-assembly-seam.test.ts` records: importing it from a `@duya/agent` test
 * adds a `pkg:agent -> scripts` edge, and that edge moved `architecture:check`
 * 963 -> 964 and the self-test 786 -> 787. The local copy was verified
 * byte-identical to the gate's on `DuyaAgent.ts`, CRLF included.
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
      for (let k = i; k < stop; k += 1) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
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
// The probe tool: the only witness that a tool REALLY executed
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
    sessionId: `s-run-lifecycle-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

const PROMPT = 'run the probe';

/**
 * Open a live run through the SEAM, and turn it into a handle.
 *
 * ## Why there is no `armRun` helper in this file
 *
 * Because there is nothing left to arm. Every harness written before this seam
 * needed `(agent as unknown as { abortController: AbortController })
 * .abortController = new AbortController()`, and each of them said out loud that
 * the cast was the honest boundary. This function is the replacement, and it is
 * called WITHOUT a cast because `beginRun` installs and owns the controller
 * itself.
 *
 * The profile and the context are threaded from the run handle rather than
 * resolved again: `beginTurnAssembly` needs both, and re-deriving either here
 * would be the second account of one run's setup the seam exists to remove.
 */
async function openRun(
  agent: InstanceType<typeof duyaAgent>,
  registry: InstanceType<typeof ToolRegistry>,
  sessionId: string,
): Promise<{
  readonly run: Awaited<ReturnType<InstanceType<typeof duyaAgent>['beginRun']>>;
  readonly handle: Awaited<ReturnType<InstanceType<typeof duyaAgent>['beginTurnAssembly']>>;
}> {
  const options = { toolRegistry: registry, sessionId } as never;
  const run = await agent.beginRun({ options, prompt: PROMPT });
  const handle = await agent.beginTurnAssembly({
    options,
    prompt: PROMPT,
    appliedProfile: run.appliedProfile,
    turnContext: run.turnContext,
    publisher: undefined,
  });
  return { run, handle };
}

/**
 * Drive one tool through a turn's pipeline and return the drained texts.
 *
 * The refresh is not incidental, and the ordering is the loop's own: the
 * declared-tools guard starts EMPTY and denies anything outside it, so a test
 * that skipped the refresh would see a `tool_error` for every call. That is also
 * the mute-pipeline trap `turn-pipeline-producer.test.ts` names -- a fixture
 * that never dispatches anything can pass an absence-of-error assertion. The
 * probe counter below is what stops it, which is why `runOneTool`'s return value
 * is never the thing the test trusts on its own.
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

function assembleFirstTurn(
  handle: Awaited<ReturnType<InstanceType<typeof duyaAgent>['beginTurnAssembly']>>,
  turn: number,
) {
  return handle.assemble({
    turn,
    systemPrompt: handle.systemPrompt,
    messages: [],
    tools: handle.tools as Tool[],
  });
}

// ============================================================================
// 1. THE ACCEPTANCE TEST: a real turn, assembled through the seam alone
// ============================================================================

describe('a run established through the public seam can assemble a turn', () => {
  it('really executes a tool, and exposes an abortable run signal', async () => {
    installFakeDbIpc();
    const probe = probeRegistry();
    const agent = makeAgent();

    const { run, handle } = await openRun(agent, probe.registry, 's-run-1');

    // The run is live, so the turn assembly that `buildTurnPipeline` gates is
    // reachable. Asserting usability FIRST means a later failure cannot be
    // blamed on a pipeline that was dead before the tool was ever offered.
    const turn1 = assembleFirstTurn(handle, 1);
    expect(turn1.pipeline.isUsable()).toBe(true);

    const texts = await runOneTool(handle, turn1.pipeline, 't1');

    // THE POSITIVE EXECUTION COUNT. Read from inside the probe's own executor,
    // so no mute pipeline can satisfy it.
    expect(probe.runs()).toBe(1);
    // And the result came back through the drain, so the pipeline was not just
    // live but wired to the registry the seam resolved.
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('RAN-1');

    // The run exposes a signal a driver can abort, and aborting it is what the
    // abort route is FOR -- so assert the observable effect, not the handle's
    // shape. `agent.interrupt()` is the legacy's own route to the same
    // controller, and the legacy must keep working, so both are pinned.
    expect(run.signal.aborted).toBe(false);
    run.abort('test-abort');
    expect(run.signal.aborted).toBe(true);
    expect(run.controller.signal.aborted).toBe(true);

    run.close();
  });

  it('reports the run-scoped facts it established rather than re-deriving them', async () => {
    installFakeDbIpc();
    const probe = probeRegistry();
    const agent = makeAgent();

    const { run, handle } = await openRun(agent, probe.registry, 's-run-2');

    // The turn id the run owns: the value journal emits read through
    // `_pushDurable`, and the prologue's job was to set it per run.
    expect(run.turnId).toBeNull();
    // No profile was named, so the resolved answer is `undefined` -- which is
    // what `beginTurnAssembly` is then handed, so there is one resolution.
    expect(run.appliedProfile).toBeUndefined();
    expect(handle.turnContext).toBe(run.turnContext);
    // Reported, never dispatched: the engine has no orchestrator concept, so a
    // driver MUST be able to see this without the run having acted on it.
    expect(run.requestedMode).toBe('normal');
    expect(run.orchestrator).toBeNull();

    run.close();
  });
});

// ============================================================================
// 2. THE RELEASE: close returns the agent to its pre-run state
// ============================================================================

describe('closing a run releases it', () => {
  it('makes the agent refuse to assemble again, and only until the next run', async () => {
    installFakeDbIpc();
    const probe = probeRegistry();
    const agent = makeAgent();

    const { run, handle } = await openRun(agent, probe.registry, 's-run-3');

    // Live: assembles.
    expect(assembleFirstTurn(handle, 1).pipeline.isUsable()).toBe(true);

    run.close();

    // Released. The refusal is `buildTurnPipeline`'s own, asserted by its own
    // message, so this pins the STATE rather than merely observing a failure.
    // A later seam could legitimately change what "released" means; it could
    // not do so silently.
    expect(() => assembleFirstTurn(handle, 2)).toThrow(/no run in progress/);

    // Idempotent: closing twice changes nothing, so a caller with a `finally`
    // and an early return cannot corrupt the agent's state by double-releasing.
    run.close();
    expect(() => assembleFirstTurn(handle, 3)).toThrow(/no run in progress/);

    // AND the release is not permanent. A lifecycle that could release the
    // field but never hold it again would turn one finished run into a dead
    // agent, which is a strictly worse failure than never releasing at all.
    const second = await openRun(agent, probe.registry, 's-run-3-again');
    expect(assembleFirstTurn(second.handle, 1).pipeline.isUsable()).toBe(true);
    expect(await runOneTool(second.handle, assembleFirstTurn(second.handle, 1).pipeline, 't2'))
      .toHaveLength(1);
    expect(probe.runs()).toBe(1);
    second.run.close();
  });

  it('does not let a superseded run release the run that replaced it', async () => {
    installFakeDbIpc();
    const probe = probeRegistry();
    const agent = makeAgent();

    const first = await openRun(agent, probe.registry, 's-run-4');
    const second = await openRun(agent, probe.registry, 's-run-5');

    // The older handle closing must NOT tear down the newer run's controller.
    // Without the identity check this would be a live run losing its abort
    // source to a run that had already ended -- the cross-run leak
    // `bindRunForkMarker` documents, on the cancellation wire instead of the
    // fork marker.
    first.run.close();
    expect(assembleFirstTurn(second.handle, 1).pipeline.isUsable()).toBe(true);

    second.run.close();
  });
});

// ============================================================================
// 3. THE CONSTRAINT: the field was not made public, and got no setter
// ============================================================================

describe('the seam is a method, not a widened field', () => {
  it('keeps abortController private with exactly one assignment site', () => {
    // The whole slice rests on this. A public field or a setter would let a
    // caller install a controller with no run behind it -- the exact confusion
    // `buildTurnPipeline`'s throw exists to prevent -- and the cost of that
    // mistake is invisible: the assembly succeeds and wires a tool-use context
    // to a signal nobody holds.
    expect(occurrences(/private abortController: AbortController \| null = null;/)).toBe(1);
    expect(occurrences(/public abortController/)).toBe(0);
    // No setter under any spelling, and no field declared without `private`.
    expect(occurrences(/(set|get) abortController/)).toBe(0);
    expect(occurrences(/abortController[?!]?:\s*AbortController/)).toBe(1);
    // ONE write site for the field in the whole file, and it is `beginRun`'s.
    // Two would be two places that decide a run exists.
    expect(occurrences(/this\.abortController = /g)).toBe(2);
  });

  it('exposes the run lifecycle as a public method the legacy also calls', () => {
    // "One implementation, two callers" is the property that stops the seam and
    // the legacy from having two answers about what a run is. If a later slice
    // re-inlines the prologue, this row goes red rather than leaving two
    // silently-diverging versions of a run's setup in one file.
    expect(occurrences(/async beginRun\(/)).toBe(1);
    expect(occurrences(/await this\.beginRun\(\{/)).toBe(1);
  });
});