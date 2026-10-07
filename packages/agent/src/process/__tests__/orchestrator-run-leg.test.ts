/**
 * Plan 610 P5: an orchestrator-paradigm mode reaches a driver that drives the
 * RUNTIME. It is ROUTED, not assembled -- and it is not silently bypassed.
 *
 * ## The gap this closes, measured
 *
 * `beginRun` reports `RunHandle.orchestrator`, and before this slice nothing
 * could ACT on that report: `_dispatchOrchestratorMode` was private, so the
 * only correct behaviour available to a driver was to refuse the turn and fail.
 * The dispatcher itself was never the obstacle -- MEASURED on the commit before
 * this one, it reads agent fields, the resolved modifier, the prompt and the
 * options, and NOTHING from `streamChat`'s closure. Private was the whole gap.
 *
 * ## Why the frames are ROUTED rather than given to the engine
 *
 * An orchestrator is a SECOND DRIVER, not a branch in the turn loop, and the
 * one line that proves it is `streamChat`'s mode branch: it yields
 * `orchestratorFramesFor(run)` and RETURNS, so `beginTurnAssembly` and the
 * `while` loop below it are never reached for that run.
 * `ModeModifierOrchestrator.execute` agrees -- it takes `llmClient`,
 * `toolRegistry` and an abort controller and "does NOT run through the agent
 * tool loop". And MEASURED on `packages/agent-runtime/src/engine/ports.ts`, that
 * module has no orchestrator member while explicitly forbidding
 * `@duya/ai`'s `SSEEvent` (whose renderer half -- `tool_group_progress`,
 * `agent_progress`, `mode_changed`, `goal_updated` -- is precisely the
 * vocabulary the engine must not carry). So the engine cannot be given this
 * run, and the frames are forwarded verbatim to the consumer the legacy
 * generator fed. `selectRunDriverLeg` is that routing, named once.
 *
 * ## What is REAL here
 *
 * REAL: a real `duyaAgent`; a REAL `ModeModifier` carrying a REAL
 * `orchestrator.execute`, registered in the REAL `modeModifierRegistry` and
 * resolved by `beginRun`'s own registry read; the real
 * `orchestratorFramesFor` seam; the real `selectRunDriverLeg`; and for the
 * ordinary leg, `composeLegacyRunPorts` with every port it binds, the real
 * `RunEngineImpl` loop, a real side-effect ledger and a real `RunSession`.
 *
 * FAKED, and only the PROVIDER and the worker DB IPC: both recorded in the
 * harness, neither replacing a leg under test.
 *
 * NOTE on the fixture, because it changes what this file can claim: MEASURED on
 * this tree, NO registered production mode declares an `orchestrator` -- the six
 * in `modes/index.ts` are all modifier-paradigm, and `research-mode.ts` says so
 * in its own header ("It does NOT take over the stream"). So the orchestrator
 * branch of `streamChat` is currently unreachable in production and this file
 * registers a mode to reach it. That makes the capability real and the branch
 * unexercised, which is the reason the routing cannot be left to a driver's
 * discretion.
 *
 * ## Why every assertion here is POSITIVE
 *
 * `turn-pipeline-producer.test.ts` documents the trap this file is shaped to
 * avoid: a muted pipeline dispatches nothing, raises nothing, and satisfies any
 * "no error was raised" reading. So the central claim is that the orchestrator's
 * OWN body ran (`executeCalls`, incremented inside `execute`) and that the
 * frames it declared reached the consumer, in order, carrying its marker. A
 * driver that dropped the mode and assembled a turn instead would satisfy every
 * absence-based assertion in the file and fail all of these.
 *
 * ## The two legs are proved from DIFFERENT sources
 *
 * The orchestrator leg is read from the fixture's own body and the consumer's
 * received frames; the engine leg is read from a probe tool's executor and the
 * provider's request count. Neither leg is compared against itself, and the
 * legacy-parity block compares the driver path against `streamChat` -- two
 * different code paths reaching one orchestrator, which is the behaviour
 * preservation this shape claims.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { RunInputSnapshot, TerminalCandidate } from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import type { ModeModifierContext, OrchestratorDeps } from '../../modes/types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER
// ============================================================================

/** One script per provider request, so turn 2 does not replay turn 1's call id. */
let providerScripts: readonly (readonly SSEEvent[])[] = [];
/** How many requests the provider was handed. A POSITIVE COUNT. */
let modelCalls = 0;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      const index = modelCalls;
      modelCalls += 1;
      const signal = options?.signal as AbortSignal | undefined;
      const script = providerScripts[Math.min(index, providerScripts.length - 1)] ?? [];
      return (async function* () {
        for (const event of script) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event as SSEEvent;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// ============================================================================
// The offline host
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { modeModifierRegistry } = await import('../../modes/registry.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const {
  composeLegacyRunPorts,
  createLegacyAssembleTurn,
  buildLegacyRunManifest,
  buildLegacyRunInput,
  selectRunDriverLeg,
} = await import('../run-composition.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
const tempDirs: string[] = [];

/**
 * Answer every worker DB request with an empty result.
 *
 * Deliberately NOT the allowlist-that-throws shape `engine-mode-exit-port.test.ts`
 * uses: the legacy-parity block below drives the WHOLE `streamChat` prologue, so
 * this harness reaches db actions the other blocks never touch. Nothing in this
 * file reads the db, so the answers are inert -- but they are shaped, because an
 * inert `null` is not the same as an inert empty row: the engine leg reads
 * `mailbox:claimBatch`'s `.rows` during a turn and a `null` there ends the run
 * `failed` with "Cannot read properties of null". The actions seen are recorded
 * so a reader can see which ones happened.
 */
const dbActions: string[] = [];

function emptyDbResult(action: string): unknown {
  if (action === 'mailbox:claimBatch') return { rows: [], claimTokens: [] };
  if (action === 'modeState:get') return null;
  return { rows: [] };
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
    dbActions.push(String(req.action));
    setImmediate(() =>
      dbListener?.({
        type: 'db:response',
        id: req.id,
        success: true,
        result: emptyDbResult(String(req.action)),
      }),
    );
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  modelCalls = 0;
  providerScripts = [];
  executeCalls = 0;
  seenQuery = '';
  seenDeps = null;
  dbActions.length = 0;
});

afterEach(() => {
  process.env = { ...originalEnv };
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

// ============================================================================
// A REAL orchestrator mode, registered in the REAL registry
// ============================================================================

const MODE_ID = 'p5-orchestrator-probe';
/** The marker every frame this fixture emits carries. */
const MARK = 'ORCH-P5';

/** How many times the orchestrator's OWN `execute` body ran. A POSITIVE COUNT. */
let executeCalls = 0;
/** The query the orchestrator was handed, to prove it is the run's own prompt. */
let seenQuery = '';
/** The deps the orchestrator was handed, to prove the run's own plumbing. */
let seenDeps: OrchestratorDeps | null = null;

/** The frames the fixture declares. Compared against what a consumer RECEIVED. */
const DECLARED: readonly SSEEvent[] = [
  { type: 'text', data: `${MARK}-alpha` },
  { type: 'text', data: `${MARK}-beta` },
  { type: 'done', reason: 'completed' },
] as unknown as readonly SSEEvent[];

/**
 * Register the mode ONCE per process.
 *
 * `ModeModifierRegistry.register` throws on a duplicate id and has no
 * unregister, so this is module state rather than a per-test fixture -- the same
 * constraint `engine-mode-exit-port.test.ts` records.
 *
 * `kind: 'message'` and an orchestrator and NOTHING else, because a mode that
 * also declared `tools`/`prompt`/`hooks` would be a mode bug
 * (`ModeModifierOrchestrator`'s own header says so) and the dispatch would then
 * prove something this file does not claim.
 */
async function registerOrchestratorMode(): Promise<void> {
  try {
    modeModifierRegistry.register({
      id: MODE_ID,
      kind: 'message',
      display: { label: 'Orchestrator probe' },
      orchestrator: {
        execute: async function* (
          query: string,
          _ctx: ModeModifierContext,
          deps: OrchestratorDeps,
        ): AsyncGenerator<SSEEvent, void, unknown> {
          executeCalls += 1;
          seenQuery = query;
          seenDeps = deps;
          for (const frame of DECLARED) yield frame;
        },
      },
    } as never);
  } catch (error) {
    if (!/already registered/.test(String(error))) throw error;
  }
}

let sessionSeq = 0;

function makeAgent(sessionId: string): InstanceType<typeof duyaAgent> {
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

function nextSessionId(label: string): string {
  sessionSeq += 1;
  return `s-${label}-${sessionSeq}`;
}

// ============================================================================
// The DRIVER: the shape `agent-process-entry.ts` will have after the flip
// ============================================================================

interface Drove {
  readonly leg: string;
  /** Exactly what the consumer received, in order. */
  readonly frames: readonly SSEEvent[];
  /** Frames narrowed to this fixture's marker, in order. */
  readonly marked: readonly string[];
  /** `run.turnContext.sessionId`, so a test can compare the dispatched deps to it. */
  readonly sessionId: string | null | undefined;
}

/**
 * Establish a run, ask the production router which leg drives it, and consume
 * the leg's frames as the entry's `for await (const event of ...)` would.
 *
 * The driver body is test-local ON PURPOSE. It is three lines of routing, and
 * the routing itself -- "which leg drives this run" -- is
 * `selectRunDriverLeg`'s, production code. A file that asserted on its own
 * routing would prove nothing; a file that drives the production routing and
 * reads the frames a real orchestrator body emitted proves the product's own
 * answer.
 */
async function drive(agent: InstanceType<typeof duyaAgent>, options: Record<string, unknown>, prompt: string): Promise<Drove> {
  const run = await agent.beginRun({ options: options as never, prompt });
  const leg = selectRunDriverLeg(agent, run);
  const frames: SSEEvent[] = [];
  if (leg.kind === 'orchestrator') {
    for await (const frame of leg.frames) frames.push(frame);
  }
  const drove: Drove = {
    leg: leg.kind,
    frames,
    marked: frames
      .map((frame) => (frame as { data?: unknown }).data)
      .filter((data): data is string => typeof data === 'string' && data.startsWith(MARK)),
    sessionId: run.turnContext.sessionId,
  };
  run.close();
  return drove;
}

// ============================================================================
// 1. THE ORCHESTRATOR LEG: routed, run, and its frames reach the consumer
// ============================================================================

describe('an established run whose mode is an orchestrator is routed to it', () => {
  it('runs the orchestrator and hands its frames to the consumer', async () => {
    installFakeDbIpc();
    await registerOrchestratorMode();
    const agent = makeAgent(nextSessionId('orch-leg'));

    const drove = await drive(agent, { mode: MODE_ID }, 'what is the answer');

    // 1. The ROUTING decision, read from the production router. This is the
    // assertion that cannot be satisfied by dropping the mode: `engine` here
    // would mean the turn is about to be assembled with no orchestrator in it.
    expect(drove.leg).toBe('orchestrator');

    // 2. THE POSITIVE EXECUTION COUNT, incremented inside the orchestrator's own
    // body. Nothing outside this module can move it, so a driver that never
    // dispatched anything cannot satisfy it.
    expect(executeCalls).toBe(1);

    // 3. The frames the consumer received, in order, from the real dispatch.
    // Asserted against the fixture's declaration and against the marker the
    // fixture stamps on each frame -- not against "an error was not raised".
    expect(drove.marked).toEqual([`${MARK}-alpha`, `${MARK}-beta`]);
    expect(drove.frames).toHaveLength(DECLARED.length);
    expect((drove.frames[drove.frames.length - 1] as { type?: string }).type).toBe('done');

    // 4. The orchestrator was handed THIS run's input, read from the handle's
    // own request rather than re-derived by the test.
    expect(seenQuery).toBe('what is the answer');

    // 5. The run's OWN plumbing reached the orchestrator: the session id is the
    // run's `turnContext` id (read from the handle, not re-derived), and the
    // abort controller is the one the handle exposes, so a driver aborting the
    // handle is aborting the orchestrator. `deps` is the agent's real
    // `OrchestratorDeps`, so this is a fact about the dispatch, not a shape.
    expect(seenDeps).not.toBeNull();
    expect(seenDeps?.sessionId).toBe(drove.sessionId);

    // 6. The engine leg was NOT offered this run: the provider was never asked,
    // because an orchestrator owns the stream and drives its own model calls.
    expect(modelCalls).toBe(0);
  });

  it('hands the orchestrator a controller the run handle can abort', async () => {
    installFakeDbIpc();
    await registerOrchestratorMode();
    const agent = makeAgent(nextSessionId('orch-abort'));

    const run = await agent.beginRun({ options: { mode: MODE_ID } as never, prompt: 'abort me' });
    const leg = selectRunDriverLeg(agent, run);
    expect(leg.kind).toBe('orchestrator');

    const received: (AbortSignal | undefined)[] = [];
    if (leg.kind === 'orchestrator') {
      for await (const frame of leg.frames) {
        expect(frame).toBeDefined();
        // Read straight off the deps the dispatch built. NO fallback to
        // `run.signal`: a fallback here would make the comparison below compare
        // the handle against itself whenever the deps were missing.
        received.push(seenDeps?.abortController.signal);
      }
    }

    // The frames were produced (so the loop above was not vacuous) and every one
    // of them was produced under the run's own signal.
    expect(received).toHaveLength(DECLARED.length);
    expect(received.every((signal) => signal === run.signal)).toBe(true);

    run.abort('p5-abort');
    expect(run.signal.aborted).toBe(true);
    expect(seenDeps?.abortController.signal.aborted).toBe(true);
    run.close();
  });
});

// ============================================================================
// 2. THE REFUSAL: an ordinary run may not be dispatched, and says so
// ============================================================================

describe('the seam refuses a run that resolved no orchestrator', () => {
  it('throws at CALL time rather than returning an empty stream', async () => {
    installFakeDbIpc();
    const agent = makeAgent(nextSessionId('orch-refuse'));

    const run = await agent.beginRun({ options: undefined, prompt: 'ordinary turn' });
    expect(run.orchestrator).toBeNull();

    // The CALL throws, before any iteration. An `async *` method would defer
    // this to the first `next()`, which a driver that forwards the stream to a
    // consumer that never pulls from it would never observe -- the mute-stream
    // failure this slice's header rules out. The message is asserted because
    // the message is what names the mistake.
    expect(() => agent.orchestratorFramesFor(run)).toThrow(/resolved to no orchestrator/);

    // And the router does not reach it: an ordinary run is the engine's.
    expect(selectRunDriverLeg(agent, run)).toEqual({ kind: 'engine' });
    expect(executeCalls).toBe(0);
    run.close();
  });
});

// ============================================================================
// 3. PARITY: the legacy generator and the driver route to the SAME dispatch
// ============================================================================

describe('the legacy generator and the driver dispatch the same orchestrator', () => {
  it('produces the same frames through streamChat as through the driver route', async () => {
    installFakeDbIpc();
    await registerOrchestratorMode();

    // Two SEPARATE agents and two separate runs, so the two sides are two
    // independent executions of one orchestrator rather than one execution read
    // twice. The comparison is legacy-generator vs driver-route: two different
    // code paths, one fixture.
    const legacyAgent = makeAgent(nextSessionId('orch-legacy'));
    const legacyFrames: SSEEvent[] = [];
    for await (const frame of legacyAgent.streamChat('what is the answer', { mode: MODE_ID } as never)) {
      legacyFrames.push(frame);
    }

    const driverAgent = makeAgent(nextSessionId('orch-driver'));
    const drove = await drive(driverAgent, { mode: MODE_ID }, 'what is the answer');

    // Both sides ran the orchestrator, once each.
    expect(executeCalls).toBe(2);
    expect(drove.leg).toBe('orchestrator');

    // Same frames, same order -- which is the behaviour preservation shape (B)
    // claims. A pin by MARKER COUNT alone would pass on a reordered stream, so
    // the whole frame list is compared, in order.
    expect(legacyFrames).toEqual(drove.frames as SSEEvent[]);
    expect(
      legacyFrames
        .map((frame) => (frame as { data?: unknown }).data)
        .filter((data): data is string => typeof data === 'string' && data.startsWith(MARK)),
    ).toEqual([`${MARK}-alpha`, `${MARK}-beta`]);
  });
});

// ============================================================================
// 4. THE ENGINE LEG: an ordinary run still really drives the engine
// ============================================================================

const PROBE = 'probe_ok';

/**
 * The probe tool: the only witness that a tool REALLY executed on the engine
 * leg, so the routing cannot have cost the ordinary turn its run.
 */
function probeRegistry(): { readonly registry: InstanceType<typeof ToolRegistry>; readonly runs: () => number } {
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
        return { id: String(input.value ?? 'none'), name: PROBE, result: `RAN-${runs}` };
      },
    } as never,
  );
  return { registry, runs: () => runs };
}

describe('an ordinary run is still the engine leg, and it really drives a turn', () => {
  it('executes a tool through composeLegacyRunPorts and RunEngineImpl', async () => {
    installFakeDbIpc();
    const sessionId = nextSessionId('engine-leg');
    const agent = makeAgent(sessionId);
    const probe = probeRegistry();

    // TWO registrations, measured reason (`turn-assembly-seam.test.ts`): the
    // engine's side-effect lookup and visibility guard read
    // `agent.activeMCPRegistry`, while the bundle `_resolveTools` resolves comes
    // from `options.toolRegistry`. One registration without the other denies
    // every dispatch and the run still completes.
    agent.activeMCPRegistry.register(
      {
        name: PROBE,
        description: 'probe that counts its own executions',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      } as never,
      { execute: async () => ({ id: 'p1', name: PROBE, result: 'RAN' }) } as never,
    );

    const prompt = 'run the probe';
    const options = { sessionId, toolRegistry: probe.registry } as never;

    // The run is established through the SEAM, with no cast: `beginRun` owns the
    // abort controller, which is what `buildTurnPipeline` refuses without.
    const run = await agent.beginRun({ options, prompt });
    expect(selectRunDriverLeg(agent, run)).toEqual({ kind: 'engine' });

    const turnPipelines = new TurnPipelinePublisher();
    const handle = await agent.beginTurnAssembly({
      options,
      prompt,
      appliedProfile: run.appliedProfile,
      turnContext: run.turnContext,
      publisher: turnPipelines,
    });
    agent.setMessages([
      ...agent.getMessages(),
      { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
    ]);

    const runId = 'run-p5-engine' as RunId;
    const session = new RunSession({
      runId,
      sessionId: 'sess-p5-engine',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence: { append: async () => undefined, complete: async () => undefined },
      flushEvery: 1_000,
    });
    const emitter = new RunEventEmitter({ runId, session, stream: { push: () => undefined } });
    emitter.emit({
      type: 'run.started',
      manifestHash: 'hash-p5',
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'orchestrator-run-leg', version: '0.0.0' },
    });

    // The real production ledger on a temp dir: no tool in the product declares a
    // side-effect class, so without a ledger the engine REFUSES every dispatch.
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-p5-'));
    tempDirs.push(ledgerDir);
    const fence: RunFence = { runId, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
    const ledger = createToolSideEffectLedger({ dir: ledgerDir, runId, runEpoch: FIRST_EPOCH, fence });

    const terminals: TerminalCandidate[] = [];
    const host: LegacyRunHost = {
      turnPipelines,
      assembleTurn: createLegacyAssembleTurn(handle),
      refreshDeclaredTools: () => handle.refreshDeclaredTools(),
      askApproval: async () => ({ allowed: true, scope: 'once' }),
      emitter,
      proposeTerminal: (candidate) => terminals.push(candidate),
      compaction: {
        decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
        compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
        nextCompactionId: () => 'cmp-p5',
      },
      seqIndex: 0,
      wakeRun: false,
      sessionId,
      workingDirectory: process.cwd(),
      beginTicket: (call) => ledger.begin(call),
      settleTicket: (input) => ledger.settle(input),
    };

    const facts: LegacyRunFacts = {
      runId,
      cwd: process.cwd(),
      model: 'claude-test',
      providerId: 'anthropic',
      sessionId: 'sess-p5-engine',
      projectId: null,
      revision: 'rev-p5',
      catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
      permissionMode: 'default',
    };
    const manifest: RunManifest = buildLegacyRunManifest(facts);
    const input: RunInputSnapshot = {
      ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
      history: { kind: 'by_ref', digest: 'hist-p5', locator: 'agent://transcript' },
    } as unknown as RunInputSnapshot;

    // TWO scripts, not one: the first-attempt fence refuses a second `begin` for a
    // call id one attempt has already recorded, so a single script replayed on
    // turn 2 would end the run `failed` on a bookkeeping refusal rather than on
    // anything this test is about.
    providerScripts = [
      [
        { type: 'text', data: 'calling the probe' },
        { type: 'tool_use', data: { id: 't1', name: PROBE, input: { value: 'alpha' } } } as unknown as SSEEvent,
        DONE,
      ],
      [{ type: 'text', data: 'done' }, DONE],
    ];

    const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
    await engine
      .execute({ manifest, input, signal: new AbortController().signal, ports: composeLegacyRunPorts(agent, host) })
      .completed();
    turnPipelines.close();

    // POSITIVE counts from two INDEPENDENT witnesses, which is the whole reason
    // this block exists: the probe's own executor and the provider's request
    // count. A routing change that sent an ordinary run down the orchestrator
    // leg would read 0 and 0 here while every orchestrator assertion above still
    // passed -- so the two legs are proved from sources that cannot both be
    // satisfied by one of them being mute.
    expect(probe.runs()).toBe(1);
    expect(modelCalls).toBe(2);
    expect(terminals.map((candidate) => candidate.state.status)).toContain('completed');
    // And the orchestrator was never involved in an ordinary run.
    expect(executeCalls).toBe(0);

    run.close();
  });
});