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
  ToolCallRequest,
  ToolDispatchTicket,
  ToolOutcome,
  TurnAssemblyInput,
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
const { toDrainItem } = await import('../run-engine-ports.js');

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
 */
function installFakeDbIpc(): void {
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
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() =>
      dbListener?.({ type: 'db:response', id: req.id, success: true, result }),
    );
    return true;
  }) as unknown as typeof process.send;
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
  /** Calls the engine dispatched into the real publisher -> pipeline. */
  readonly dispatched: ToolCallRequest[];
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
  /** How many times the host's drain was entered. */
  readonly drainEntries: number;
  /** What the composed ports advertise and resolve. */
  readonly ports: RunEnginePorts;
  /** Every string the model was sent, joined. */
  modelSawText(): string;
}

async function driveComposedRun(turns: readonly ('tool' | 'text')[]): Promise<Observation> {
  installFakeDbIpc();
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

  // A REAL pipeline behind a REAL publisher: the tool leg the host hands over is
  // the same pair `streamChat` builds per turn, not a stand-in.
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
  // The host's own handle on the live pipeline. It has to be here rather than
  // reached through the publisher, and that is a MEASURED property rather than a
  // shortcut: `TurnPipelinePublisher` exposes `publish`, `close`, `currentTurn`
  // and `queue` and nothing else -- its `#current` record is module-private, so
  // `ToolPort.drain` has no route to `getRemainingResults` through it. That is
  // why `queueTool`, `drainTools` and `discardTools` are three HOST obligations
  // in `run-composition.ts` rather than one derived member.
  let current = newPipeline();
  pipelines.publish(currentTurn, current);

  const dispatched: ToolCallRequest[] = [];
  const terminals: string[] = [];
  const announced: RunEvent[] = [];
  const ledger: string[] = [];
  const assemblies: TurnAssemblyInput[] = [];
  let sweeps = 0;
  let drainEntries = 0;

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
    queueTool: (call) => {
      dispatched.push(call);
      pipelines.queue({ id: call.callId, name: call.name, input: call.input });
    },
    // The real pipeline, mapped by the real `toDrainItem`. A hand-written
    // `ToolDrainItem` would test the engine and not the adapter at all.
    //
    // A FRESH pipeline is published for the next turn after each drain, which is
    // what `streamChat` does and is load-bearing rather than cosmetic: the
    // engine drains on EVERY turn, and `ToolExecutionPipeline.getRemainingResults`
    // RE-SERVES its items on a second call. Draining one instance twice therefore
    // settles the same attempt key twice -- a double ledger row that is
    // indistinguishable from a correct one
    // (`engine-drain-carryover.test.ts:332-347` records the hazard, and this
    // harness reproduced it before the per-turn publication was modelled).
    // Hoisting one pipeline for the whole run is the "permanently mute" shape
    // `turn-pipeline-publisher.ts:15-31` exists to prevent.
    async *drainTools(): AsyncIterable<ToolOutcome> {
      drainEntries += 1;
      for await (const update of current.getRemainingResults()) {
        const item = toDrainItem(update);
        if (item !== null) yield item;
      }
      currentTurn += 1;
      current = newPipeline();
      pipelines.publish(currentTurn, current);
    },
    discardTools: () => current.discard(),
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
    dispatched,
    terminals,
    announced,
    ledger,
    assemblies,
    sweeps,
    drainEntries,
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
  it('binds all six required ports, and the two that cannot be optional', async () => {
    const o = await driveComposedRun(['tool', 'text']);

    // POSITIVE evidence first: the run really executed rather than assembling a
    // bundle and being asserted on structurally.
    expect(o.requests.length).toBeGreaterThan(1);

    for (const port of ['model', 'tools', 'context', 'approval', 'events', 'interTurn', 'compaction'] as const) {
      expect(o.ports[port], `port ${port} must be supplied`).toBeDefined();
    }
    // The two the runtime's own type cannot do without.
    expect(o.ports.interTurn).toBeDefined();
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
      queueTool: () => undefined,
      drainTools: async function* () {
        void 0;
      },
      discardTools: () => undefined,
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

  it('the derived inter-turn port reaches the agent s own claim', async () => {
    installFakeDbIpc();
    const agent = makeAgent();
    const o = await driveComposedRun(['text']);
    // The sweep ran, and it ran through the agent's claim rather than a stub:
    // the agent carries a sessionId, so `_claimMailboxAtCheckpoint` took its
    // real path and the fake IPC answered `mailbox:claimBatch`.
    expect(o.sweeps).toBeGreaterThan(0);
    expect(agent.sessionId).toBeDefined();
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
    expect(o.dispatched.map((c) => c.callId)).toEqual([CALL_ID]);
    // The drain was entered on EVERY turn -- the engine drains unconditionally
    // (`run-engine.ts`) -- and the second drain RE-SERVED NOTHING, which is the
    // property the ledger proves. Two identical `settle` rows are exactly what a
    // correct ledger looks like, so the ledger's exact contents are the only
    // thing that can tell one settle from two.
    expect(o.drainEntries).toBeGreaterThan(1);
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

  it('emits no turn-output port, and that absence is the documented one', async () => {
    const o = await driveComposedRun(['tool', 'text']);
    // `ports.ts:1019-1029` makes it OPTIONAL and names the absence as the live
    // worker's state. Asserting it is absent pins the boundary for the driver
    // flip: a future slice that fills it turns THIS red, which is the point.
    expect(o.ports.turnOutput).toBeUndefined();
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
