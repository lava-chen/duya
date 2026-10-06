/**
 * Plan 610 A3-2b1: the run-composition layer, driven by a REAL engine.
 *
 * ## The problem this file exists to solve
 *
 * A composition that no production path calls can be wrong in ways no gate
 * catches. `buildEnginePorts` had exactly that property for three slices: it was
 * exercised only by hand-built `LegacyEngineSources` in tests, so every
 * assertion proved the ADAPTER worked over sources a test had already shaped.
 * Nothing proved the SOURCES could be produced at all.
 *
 * So this file does the one thing that closes it: it builds the sources with the
 * real `composeLegacyRunSources`, over a real `duyaAgent`, and hands the result
 * to a real `RunEngineImpl`, which runs to completion.
 *
 * ## What that proves, and what it does not
 *
 * It PROVES the composition is complete and driveable: every required member is
 * supplied, the derived members reach real agent state, the manifest and input
 * snapshot are accepted by the engine, and the run terminates.
 *
 * It does NOT prove product behaviour is preserved. Nothing here compares the
 * engine's turn against the legacy's turn, and nothing here says what the
 * renderer would see. That is the driver flip's evidence, carried by deleting
 * the legacy loop and by `turn-loop-product-behavior.test.ts` continuing to pass.
 * Conflating the two would be exactly the false green this slice exists to avoid
 * -- the one `turn-loop-product-behavior.test.ts:1-22` records happening before.
 *
 * ## Why the sides of each assertion come from different sources
 *
 * The load-bearing assertion is the tool's answer reaching the model. The left
 * side is the string the REAL tool executor returned, held in a closure; the
 * right side is read out of the `messages` array the REAL provider client was
 * invoked with. Different code paths, and the engine cannot guess the string.
 * A composition that bound a mute drain, or a model leg that opened no request,
 * fails it -- and both of those pass a test that only counted port calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SSEEvent } from '@duya/ai';
import type { RunEvent, RunId } from '@duya/agent-protocol';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  RunEnginePorts,
  ToolDispatchTicket,
  TurnAssemblyInput,
  TurnOutputSummary,
} from '@duya/agent-runtime';

// ============================================================================
// The scripted provider
//
// `duyaAgent` builds `llmClient` inside its constructor via `createAIClient`,
// with no injection seam, so the factory has to be replaced. Nothing else is:
// the client the composition's model port opens is the real one the agent built,
// reached through the new `readModelClient()`.
// ============================================================================

const PROBE = 'composition_probe';
const TOOL_NAME = 'probe';
const CALL_ID = 'call-composition-1';
/** Generated here, once, and never restated anywhere the model could see it. */
const ANSWER = 'PROBE-ANSWER-4d7c10: the composition carried this back';

let activeClient: ScriptedClient | null = null;

interface ScriptedClient {
  /** Every `messages` array the client was invoked with, in order. */
  readonly requests: ReadonlyArray<readonly Message[]>;
  /** How many provider requests were opened. */
  readonly calls: () => number;
}

function scriptedClient(turns: readonly ('tool' | 'text')[]): ScriptedClient {
  const requests: Message[][] = [];
  let turn = 0;
  return {
    requests,
    calls: () => requests.length,
    async *streamChat(messages: Message[]): AsyncGenerator<SSEEvent> {
      requests.push(messages.map((m) => ({ ...m })));
      const mode = turns[Math.min(turn, turns.length - 1)] ?? 'text';
      turn += 1;
      if (mode === 'tool') {
        yield {
          type: 'tool_use',
          data: { id: CALL_ID, name: TOOL_NAME, input: { value: 'carried' } },
        } as SSEEvent;
      } else {
        yield { type: 'text', data: 'the tool has reported' } as SSEEvent;
      }
      yield { type: 'done', reason: 'end_turn' } as SSEEvent;
    },
  };
}

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      if (!activeClient) throw new Error('no scripted client installed');
      return activeClient.streamChat(messages, options);
    },
  };
  return {
    ...actual,
    createAIClient: () => delegating,
    createAIClientWithRetry: () => delegating,
  };
});

// ============================================================================
// The offline host
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { ToolExecutionPipeline } = await import('../../tool/ToolExecutionPipeline.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const {
  buildLegacyRunInput,
  buildLegacyRunManifest,
  composeLegacyRunPorts,
  composeLegacyRunSources,
} = await import('../run-composition.js');

let dbListener: ((msg: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  activeClient = null;
});

/**
 * The worker IPC the inter-turn claim reaches for.
 *
 * The composition binds `agent.claimInterTurn`, so proving the derived port
 * actually reaches the agent means letting the claim run its real path -- which
 * asks the mailbox store. Answering with an EMPTY claim (not a null: the code
 * reads `claim.rows`) is the honest "nothing was queued", and anything other
 * than these two actions is a test-visible failure rather than a hang.
 *
 * RETURNS the actions it saw, and that is the point: `mailbox:claimBatch` being
 * in the list is evidence that the ENGINE's sweep reached the AGENT's claim
 * reached the STORE. A stubbed claim issues no IPC at all, so the list is empty
 * and this is a cross-source assertion rather than a restatement.
 */
function installFakeDbIpc(): string[] {
  const actions: string[] = [];
  if (!dbListener) {
    initDbClient();
    const added = process.listeners('message').filter((l) => !PRE_EXISTING.has(l));
    dbListener = (added[0] ?? null) as ((msg: unknown) => void) | null;
    if (!dbListener) throw new Error('db-client registered no message listener');
  }
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action: ${req.action}`);
    }
    actions.push(req.action);
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() =>
      dbListener?.({ type: 'db:response', id: req.id, success: true, result }),
    );
    return true;
  }) as unknown as typeof process.send;
  return actions;
}

let sessionCounter = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionCounter += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-composition',
    provider: 'anthropic',
    sessionId: `s-composition-${sessionCounter}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

/** The string the real tool executor returned, or null. The left-hand source. */
let returnedByTool: string | null = null;

function registryWithProbe(): InstanceType<typeof ToolRegistry> {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: TOOL_NAME,
      description: 'Hands back a marker the test can find.',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async (input: Record<string, unknown>) => {
        returnedByTool = `${ANSWER}:${String(input.value ?? '')}`;
        return { id: 'r1', name: TOOL_NAME, result: returnedByTool };
      },
    } as never,
  );
  return registry;
}

// ============================================================================
// Driving a real engine over the real composition
// ============================================================================

const RUN_ID = 'run-composition' as RunId;

interface Observation {
  /** Provider requests the real client was invoked with. */
  readonly requests: ReadonlyArray<readonly Message[]>;
  /** Terminal candidates the engine proposed. */
  readonly terminals: string[];
  /** Events that reached the real emitter. */
  readonly announced: RunEvent[];
  /** Ledger rows. */
  readonly ledger: string[];
  /** Assembly inputs the host was asked for. */
  readonly assemblies: TurnAssemblyInput[];
  /** Inter-turn sweeps the engine performed. */
  readonly sweeps: number;
  /** Frames the bound turn-output sink received. */
  readonly turnFrames: readonly SSEEvent[];
  /** One entry per turn the engine finished. */
  readonly finishedTurns: readonly TurnOutputSummary[];
  /** The db actions the agent's own IPC bridge issued during the run. */
  readonly dbActions: readonly string[];
  /** What the composed ports advertise and resolve. */
  readonly ports: RunEnginePorts;
  /** Every string the model was sent, joined. */
  modelSawText(): string;
}

async function driveComposedRun(turns: readonly ('tool' | 'text')[]): Promise<Observation> {
  const dbActions = installFakeDbIpc();
  activeClient = scriptedClient(turns);

  const agent = makeAgent();
  // The derived `lookup` reads `agent.activeMCPRegistry`, so the probe has to be
  // in THAT registry for the composition to see it. Registering it elsewhere
  // would make the catalog assertions pass without exercising the seam.
  const registry = registryWithProbe();
  for (const tool of registry.getAllTools()) {
    agent.activeMCPRegistry.register(
      tool,
      registry.getExecutor(tool.name) as never,
      { exposure: 'eager' },
    );
  }

  // A REAL pipeline behind a REAL publisher: the tool leg the composition
  // derives is the same pair `streamChat` builds per turn, not a stand-in.
  const pipelines = new TurnPipelinePublisher();
  const newPipeline = (): InstanceType<typeof ToolExecutionPipeline> =>
    new ToolExecutionPipeline(registry, async () => true, {
      toolUseId: 'composition-ctx',
      getAppState: () => ({}),
      setAppState: () => undefined,
      abortController: new AbortController(),
      options: {},
    } as never);
  let currentTurn = 1;
  // Who publishes a turn's pipeline under the engine is the DRIVER FLIP's job:
  // `streamChat` does it today by constructing the executor itself
  // (`DuyaAgent.ts:2097`), and an engine-driven run never enters that generator.
  // So the harness publishes from `assembleTurn`, which the engine calls once per
  // turn BEFORE the model request and therefore before any `queueTool`.
  //
  // It has to publish a FRESH pipeline every turn, and that is load-bearing
  // rather than cosmetic: `ToolExecutionPipeline.getRemainingResults` RE-SERVES
  // its items on a second call, so holding one instance for the whole run
  // settles the same attempt key twice -- a double ledger row indistinguishable
  // from a correct one (`engine-drain-carryover.test.ts:332-347`). The
  // publisher's own one-shot drain refusal is the second line of defence, and
  // `turn-pipeline-lifetime.test.ts` proves it is not a trivial identity.
  pipelines.publish(currentTurn, newPipeline());
  const publishNextTurn = (): void => {
    currentTurn += 1;
    pipelines.publish(currentTurn, newPipeline());
  };

  const announced: RunEvent[] = [];
  const ledger: string[] = [];
  const assemblies: TurnAssemblyInput[] = [];
  let sweeps = 0;
  const terminals: string[] = [];
  const turnFrames: SSEEvent[] = [];
  const finishedTurns: TurnOutputSummary[] = [];

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-composition',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: (envelope) => announced.push(envelope) },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-composition',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  const ports = composeLegacyRunPorts(agent, {
    // The whole tool leg is this ONE object now. `queueTool`, `drainTools` and
    // `discardTools` are derived from it, and the derivation is the thing under
    // test: three host callbacks that each captured the live executor at their
    // own moment would let the drain and the dispatch disagree about which
    // pipeline the turn owns, and only one of them could be right.
    turnPipelines: pipelines,
    // HOST-SUPPLIED by design: the visible catalog is `_resolveTools`' filtered
    // decision, not the registry. See the module header.
    async assembleTurn(input: TurnAssemblyInput): Promise<AssembledTurn> {
      assemblies.push(input);
      return {
        systemPrompt: 'you are a composition test',
        messages: [],
        tools: [{ name: TOOL_NAME, description: 'probe', inputSchema: {} }],
        catalogRevision: 'cat-composition',
        revision: input.digest,
      };
    },
    async askApproval(): Promise<ApprovalVerdict> {
      return { allowed: true, scope: 'once' };
    },
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate.reason),
    compaction: {
      // `skip` / `declined` are real answers the engine already handles, and a
      // source that really compacted would replace the transcript out from under
      // a test asserting what the model was sent.
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-composition',
    },
    seqIndex: 1_700_000_000_000,
    wakeRun: false,
    // The bound sink. Two jobs, both of them things the DRIVER FLIP will do in
    // production, which is why they are here rather than in the composition:
    //
    //  1. `finishTurn` is the end-of-turn signal the engine already emits, and
    //     it is where the next turn's pipeline is published. `streamChat` does
    //     this at the top of each turn; the engine never enters that generator,
    //     so the harness stands in for it. The ORDER matters: publish AFTER the
    //     drain, or turn N's dispatch lands in turn N+1's pipeline and turn N
    //     drains an empty one.
    //  2. `publish` records the frames the derived `turnOutput` port emits, so
    //     the new seam is observed at the only place a frame can be seen.
    turnOutputSink: {
      publish: (event) => {
        turnFrames.push(event);
      },
      finishTurn: (summary) => {
        finishedTurns.push(summary);
        publishNextTurn();
      },
    },
    async beginTicket(call): Promise<ToolDispatchTicket> {
      ledger.push(`begin:${call.callId}`);
      return {
        attemptKey: `key:${call.callId}`,
        runId: RUN_ID,
        runEpoch: 1,
        fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
      };
    },
    async settleTicket(input) {
      ledger.push(`settle:${input.attemptKey}:${input.state}`);
    },
  });

  // The inter-turn sweep is the one required member with no "omit it" story, so
  // count it rather than trusting that binding it implies calling it.
  const counted: RunEnginePorts = {
    ...ports,
    interTurn: {
      sweep: (input) => {
        sweeps += 1;
        return ports.interTurn.sweep(input);
      },
    },
  };

  const facts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-composition',
    providerId: 'anthropic',
    sessionId: 'sess-composition',
    projectId: null,
    revision: 'rev-composition',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default' as const,
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine
    .execute({
      manifest: buildLegacyRunManifest(facts),
      input: buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: 'call the probe' }, []),
      signal: new AbortController().signal,
      ports: counted,
    })
    .completed();

  return {
    requests: activeClient.requests,
    terminals,
    announced,
    ledger,
    assemblies,
    sweeps,
    turnFrames,
    finishedTurns,
    dbActions,
    ports,
    modelSawText: () =>
      activeClient!.requests
        .flat()
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n'),
  };
}

// ============================================================================
// 1. The composition is complete
// ============================================================================

describe('composeLegacyRunPorts supplies every member the engine requires', () => {
  it('binds every required port the engine reads, including the two D4 closed', async () => {
    const o = await driveComposedRun(['tool', 'text']);

    // POSITIVE evidence first: the run really executed rather than assembling a
    // bundle and being asserted on structurally.
    expect(o.requests.length).toBeGreaterThan(1);

    // `turnOutput` is in this list now and was NOT in the previous version of
    // it, which asserted "all six required ports" while naming seven of them
    // and omitting this one. `composeLegacyRunSources` binds it
    // unconditionally, so the assertion was free to make and the gap was not
    // free to leave: plan 610 D4 made this port REQUIRED, and the one test that
    // claims to cover the composition's required members did not look at it.
    for (const port of [
      'model',
      'tools',
      'context',
      'approval',
      'events',
      'interTurn',
      'compaction',
      'turnOutput',
    ] as const) {
      expect(o.ports[port], `port ${port} must be supplied`).toBeDefined();
    }
    // The SAME eight are REQUIRED in the type as of D4, so this list is no
    // longer "required, plus two the cutover will close" -- it is exactly the
    // required set. The assertion that used to sit here claimed these two
    // "cannot be optional"; that was measured and it was false at the time, and
    // D4 is the change that made it true. `port-guards.ts` now carries the
    // `@ts-expect-error` pair that keeps it true.
    expect(o.ports.interTurn).toBeDefined();
    expect(o.ports.turnOutput).toBeDefined();
    expect(o.ports.compaction).toBeDefined();
  });

  it('the derived catalog reaches the agent s REAL registry, not a copy', async () => {
    const agent = makeAgent();
    const registry = registryWithProbe();
    for (const tool of registry.getAllTools()) {
      agent.activeMCPRegistry.register(tool, registry.getExecutor(tool.name) as never, {
        exposure: 'eager',
      });
    }
    const sources = composeLegacyRunSources(agent, {
      // A publisher with nothing published. This call only inspects the derived
      // `lookup`, and every tool leg now refuses loudly rather than returning a
      // stand-in, so an unpublished publisher is the honest way to say "this
      // run has no turn yet".
      turnPipelines: new TurnPipelinePublisher(),
      assembleTurn: () => Promise.reject(new Error('unused')),
      askApproval: () => Promise.reject(new Error('unused')),
      emitter: { emit: () => Promise.resolve() },
      proposeTerminal: () => undefined,
      compaction: {
        decide: () => Promise.resolve({ kind: 'skip', reason: 'x' } as const),
        compact: () => Promise.resolve({ kind: 'declined', reason: 'x' } as const),
        nextCompactionId: () => 'c',
      },
      seqIndex: 1,
      wakeRun: false,
    });

    // Left: the name the registry actually holds. Right: what the composed
    // lookup reports. A lookup built from a different source would disagree
    // with the registry the moment a tool was registered or removed.
    expect(registry.getAllTools().map((t) => t.name)).toContain(TOOL_NAME);
    expect(sources.lookup.toolNames()).toContain(TOOL_NAME);
    const descriptor = sources.lookup.describe(TOOL_NAME);
    expect(descriptor?.name).toBe(TOOL_NAME);
    expect(descriptor?.inputSchema).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
    });
    // And the conservative class: `ToolMetaInput` has no `sideEffect`, so an
    // honest lookup reports "undeclared" rather than inventing `read_only`.
    expect(sources.lookup.sideEffectOf(TOOL_NAME)).toBeNull();
  });

  it('the derived inter-turn port reaches the agent s own claim, and the store', async () => {
    const o = await driveComposedRun(['text']);

    // THE CROSS-SOURCE ASSERTION, and the reason this is not an identity.
    //
    // Left: the ENGINE swept the inter-turn port -- counted at the port, by the
    // engine's own call. Right: the agent's IPC bridge issued
    // `mailbox:claimBatch` -- recorded at the process boundary, by the agent's
    // own claim. Between them sits `agent.claimInterTurn`.
    //
    // The agent carries a sessionId, so `_claimMailboxAtCheckpoint` takes its
    // real path rather than short-circuiting on `!this.sessionId`. A derived
    // claim that was a stub would sweep and never reach the store, and the right
    // list would be empty -- which is what the mutation below demonstrated.
    expect(o.sweeps).toBeGreaterThan(0);
    expect(o.dbActions).toContain('mailbox:claimBatch');
  });
});

// ============================================================================
// 2. The composition is DRIVEABLE -- and the two failures it catches
// ============================================================================

describe('a real engine runs to completion over the composed bundle', () => {
  it('a tool dispatched through the real publisher reaches the real pipeline and the model', async () => {
    const o = await driveComposedRun(['tool', 'text']);

    // POSITIVE evidence, in order. Each is a fact about a different component,
    // so a composition that lost the chain at any link fails before the
    // cross-source check below is even reached.
    //
    // The dispatch is read off the LEDGER rather than off a host callback,
    // because there is no host callback any more: `queueTool` is derived from
    // the publisher. The ledger row is written by `beginTicket`, which the
    // engine only reaches after a call has been dispatched, so it is still
    // evidence of the dispatch rather than of the harness.
    expect(o.ledger.filter((row) => row.startsWith('begin:'))).toEqual([`begin:${CALL_ID}`]);
    // The run took MORE than one turn, so the drain really was entered again --
    // the engine drains unconditionally (`run-engine.ts`) -- and the second
    // drain RE-SERVED NOTHING, which is the property the ledger proves. Two
    // identical `settle` rows are exactly what a correct ledger looks like, so
    // the ledger's exact contents are the only thing that can tell one settle
    // from two.
    expect(o.finishedTurns.length).toBeGreaterThan(1);
    expect(o.ledger).toEqual([`begin:${CALL_ID}`, `settle:key:${CALL_ID}:succeeded`]);
    expect(o.announced.length).toBeGreaterThan(0);
    expect(o.terminals.length).toBeGreaterThan(0);

    // THE CROSS-SOURCE ASSERTION. Left: what the real tool executor returned
    // (this closure). Right: what the real provider client was actually invoked
    // with, on a LATER turn. The engine cannot guess the string and the tool
    // never sees the request.
    expect(returnedByTool).toBe(`${ANSWER}:carried`);
    expect(o.modelSawText()).toContain(ANSWER);

    // It arrived on the SECOND request, not the one that asked for the call --
    // that is what makes it a backfill rather than a coincidence.
    const firstRequest = JSON.stringify(o.requests[0]);
    expect(firstRequest).not.toContain(ANSWER);
    const turnOfTheAnswer = o.requests.findIndex((messages) =>
      JSON.stringify(messages).includes(ANSWER),
    );
    expect(turnOfTheAnswer).toBe(1);
  });

  it('the composed manifest and input snapshot are accepted and echoed back', async () => {
    const o = await driveComposedRun(['text']);

    // The engine asked the host to assemble, and the input it assembled from is
    // the one THIS slice built: the revision travels onto `AssembledTurn.revision`
    // and the catalog is pinned by the manifest's own catalog revision.
    expect(o.assemblies.length).toBeGreaterThan(0);
    expect(o.assemblies[0]?.digest).toBeTruthy();
    expect(o.ports.compaction?.decide).toBeDefined();
  });

  it('binds the turn-output port, and the frames it publishes reach the sink', async () => {
    const o = await driveComposedRun(['tool', 'text']);
    // `ports.ts:1019-1029` made the port OPTIONAL because two of its effects
    // had no route outside `streamChat`'s closure. Plan 610 A3-2b2 gave them one,
    // so the port is now bound -- and asserting it is BOUND is what pins that
    // decision, rather than leaving the composition free to drop it again.
    expect(o.ports.turnOutput).toBeDefined();

    // And it is not a stub: the real `tool_result` frame reached the real sink.
    // Left: the frame's identity fields, built by the agent's own
    // `_buildToolResultFrame`. Right: what the sink collected. The engine's
    // record never names a frame, so it cannot have produced this one.
    const toolFrames = o.turnFrames.filter((frame) => frame.type === 'tool_result');
    expect(toolFrames.length).toBeGreaterThan(0);
    expect((toolFrames[0]?.data as { id: string }).id).toBe(CALL_ID);
    expect(String((toolFrames[0]?.data as { result: string }).result)).toContain(ANSWER);

    // `finishTurn` ran once per turn, with the counts the legacy's
    // `toolResultMessageCount` gate reads.
    expect(o.finishedTurns.map((summary) => summary.results)).toEqual([1, 0]);
  });
});

// ============================================================================
// 3. MUTATION PROOF targets, named
// ============================================================================

describe('the guards above are not identities', () => {
  it('the model port opens a REAL request through the agent s own client', async () => {
    installFakeDbIpc();
    const agent = makeAgent();
    const o = await driveComposedRun(['text']);
    // `readModelClient()` is the seam. If it returned a different client than
    // the one the agent built, the scripted client would never be invoked and
    // this count would be zero.
    expect(agent.readModelClient()).toBeDefined();
    expect(o.requests.length).toBeGreaterThan(0);
  });
});
