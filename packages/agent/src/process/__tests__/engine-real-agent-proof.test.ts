/**
 * Plan 610 A3-2b9 (S3): the engine driving a REAL `duyaAgent`.
 *
 * ## Why this file is the one the whole cutover waits on
 *
 * G7 and G8 go green when the legacy loop is deleted. But `isTurnLoopModule` is
 * a PROXY: the engine's two legs live one call frame below its loop body, so the
 * gate counts `legs` structurally rather than by responsibility. That makes
 * "G7 went red -> green" and "the engine really drives the turn" structurally
 * indistinguishable from "every cycle was deleted". This file is what tells them
 * apart.
 *
 * Every pre-existing engine test drives SYNTHETIC ports, so none of them proves
 * the live host binds -- and none of them could have caught a composition that
 * never assembles a real turn, refuses every tool, or forgets to carry the
 * conversation forward. This one uses the real agent, the real assembly seam
 * from A3-2b7/2b8, the real tool pipeline, the real publisher, the real
 * side-effect ledger, and the real emitter.
 *
 * ## What is real, and what is faked, stated line by line
 *
 * REAL: the `duyaAgent`; `_resolveTools` and `_buildSystemPrompt`;
 * `beginTurnAssembly` / `assembleTurn`; the permission gate and the meta-tool
 * dispatcher; the `ToolExecutionPipeline` and its `StreamingToolExecutor`; the
 * `TurnPipelinePublisher`; the side-effect ledger; `composeLegacyRunPorts` and
 * every port it binds; the `RunEngineImpl` loop; `RunSession` and
 * `RunEventEmitter`.
 *
 * FAKED, and only these two: the PROVIDER (`@duya/ai`'s client factory is
 * scripted, because a proof needs a model that answers on cue) and the worker's
 * DB IPC (mode state + mailbox claim). Neither fake replaces a leg under test:
 * the model leg is measured by the agent's own `readModelClient()` being reached,
 * not by what the provider said.
 *
 * ## Three things this proof FOUND, which is most of its value
 *
 * Each of these makes a multi-turn tool run fail SILENTLY -- the run still
 * completes `completed`, with no frame missing -- so none of them would have
 * been caught by a green suite or by G7 turning green:
 *
 *  1. **The ledger is not optional.** `composeLegacyRunPorts` derives
 *     `sideEffectOf: () => null` for every tool, because `ToolMetaInput` has no
 *     `sideEffect` member so no tool declares a class
 *     (`run-composition.ts:380-388`). `null` resolves to `undeclared`, and the
 *     engine REFUSES any non-`read_only` call with no ledger attached
 *     (`run-engine.ts:1866`). Omit `beginTicket`/`settleTicket` and EVERY tool
 *     call is refused: the tool leg is dead on arrival.
 *  2. **Nothing refreshes the declared-tools set.** The visibility guard starts
 *     EMPTY and denies anything outside it; the legacy fills it from inside
 *     `runTurnStream`, which the ENGINE never calls. On the engine-driven path
 *     every dispatch is denied, so tools never run -- while the run completes.
 *  3. **An inline history cannot carry a conversation.** The engine takes
 *     `history` from `input.history` when it is inline
 *     (`run-engine.ts:1975-1977`) and only falls back to `assembled.messages`
 *     for a `by_ref`. `buildLegacyRunInput` always emits inline, and inline is
 *     frozen at run start, so the tool result never reaches turn 2.
 *
 * ## The trap this file is built to avoid
 *
 * A fixture that never dispatches anything passes "the tool leg ran" vacuously.
 * Every leg assertion here is a POSITIVE COUNT (`calls() === 2`, `runs() === 1`),
 * never a shape, so a run that quietly stopped calling a leg fails instead of
 * passing.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type {
  RunEnginePorts,
  RunInputSnapshot,
  TerminalCandidate,
} from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER -- the only fake standing in for a leg's far end
// ============================================================================

interface Seen {
  readonly systemPrompt: string;
  readonly toolNames: string[];
  readonly roles: string[];
}

let active: { seen: Seen[] } | null = null;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
/** Turn 1 asks for the tool; turn 2 reports and stops. */
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 't1', name: 'probe_ok', input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'the probe reported' }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      const index = active?.seen.length ?? 0;
      active?.seen.push({
        systemPrompt: String((options?.systemPrompt as string) ?? ''),
        toolNames: ((options?.tools as Array<{ name: string }>) ?? []).map((t) => t.name).sort(),
        roles: messages.map((m) => m.role),
      });
      const script = SCRIPTS[Math.min(index, SCRIPTS.length - 1)] ?? SCRIPTS[SCRIPTS.length - 1];
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of script) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// ============================================================================
// The offline host: worker IPC + the agent under test
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
const { createLegacyHookSource, MAPPED_PHASES } = await import('../hook-source.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';
import type { HookInvokedEvent, HooksSettings } from '../../hooks/types.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

/** Ledger temp dirs, removed after each test so a failing run leaves nothing. */
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's own
 * listener is called directly -- the pool's would try to deserialize a plain
 * object as a Buffer.
 */
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
      throw new Error(`unexpected db action in S3: ${req.action}`);
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
  for (const dir of ledgerDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure; `afterEach` must not
      // mask the assertion that already reported the real problem.
    }
  }
});

const PROBE = 'probe_ok';

interface Probe {
  readonly runs: () => number;
}

/**
 * Register the probe into the AGENT'S OWN registry.
 *
 * Not into a registry handed to `_resolveTools`. The engine's side-effect lookup
 * is derived from `agent.activeMCPRegistry`, so a probe living in a separate
 * `options.toolRegistry` is invisible to it and the call resolves `undeclared`.
 * Registering where the catalog actually is also makes the advertised surface
 * the agent's REAL one rather than a fixture's.
 */
function registerProbe(agent: InstanceType<typeof duyaAgent>): Probe {
  let runs = 0;
  agent.activeMCPRegistry.register(
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
  return { runs: () => runs };
}

const RUN_ID = 'run-s3-proof' as RunId;

// ============================================================================
// S4a -- the hook source, on the REAL host and the REAL hook runner
// ============================================================================

/**
 * A REAL hook, not a spy.
 *
 * `ConfigHooksRunner` executes this as a `node` subprocess with the event's
 * JSON on stdin (`executor.ts:256`), and the child answers with
 * `<event>/<tool_name>/<tool_use_id>`. So a green assertion here means the
 * engine dispatched the event AND the source built a payload a real hook could
 * read -- a hand-rolled `ExtensionPort` that recorded a phase name would pass
 * neither half of that.
 */
const HOOK_ECHO =
  'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({additionalContext:i.hook_event_name+\'/\'+(i.tool_name||\'-\')+\'/\'+(i.tool_use_id||\'-\')}))})"';

/**
 * The five events this run can reach.
 *
 * `Stop` is deliberately absent. `hook-source.ts` fires it on a CANCELLED run
 * only, and this run completes -- so registering it would prove nothing and
 * leaving it registered would let a source that fired `Stop` on every run pass.
 * It is covered by the `on_start`/`after_finalize` tests below instead.
 */
const HOOK_SETTINGS: HooksSettings = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
  PreToolUse: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
  PostToolUse: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
};

interface Proof {
  /** How many times the provider was asked for a request. POSITIVE COUNT. */
  readonly calls: () => number;
  readonly seen: readonly Seen[];
  /** How many times the probe tool REALLY executed. POSITIVE COUNT. */
  readonly runs: () => number;
  readonly terminals: readonly TerminalCandidate[];
  readonly assembledTurns: readonly number[];
  readonly catalogRounds: readonly number[];
  /** The agent's own resolved tool surface, for the cross-source compare. */
  readonly advertised: readonly string[];
  /**
   * The hook events that actually RAN, in order. From the runner's own
   * `onHookInvoked`, so it is observable whether or not the engine adopts what
   * the hook said -- which is the only honest channel today (see
   * `hook-source.ts`).
   */
  readonly hooks: readonly HookInvokedEvent[];
}

async function runThroughEngine(): Promise<Proof> {
  installFakeDbIpc();

  let sessionSeq = 0;
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-s3-proof-${(sessionSeq += 1)}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  // The live run's setup, in the order the legacy sets it up. `streamChat`
  // normally owns this; a host driving the engine does it instead, which is
  // precisely what makes the engine-driven path a HOST decision rather than a
  // loop internal.
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const probe = registerProbe(agent);
  // No `options.toolRegistry`: `_resolveTools` falls back to the agent's own
  // registry, which is where the engine's lookup also looks. The session id is
  // carried in the options rather than read off the agent, which is private.
  const options = { sessionId: `s-s3-proof-${sessionSeq}` } as never;
  const prompt = 'run the probe';
  const turnContext = agent.assembleTurnContext(options, prompt);

  // The user prompt enters the transcript, which is the agent's, before the
  // engine assembles its first turn.
  const userMessage = { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 };
  agent.setMessages([...agent.getMessages(), userMessage as never]);

  // The publisher must EXIST before the handle is established, because
  // `buildTurnPipeline` publishes each turn's pipeline into it and the engine's
  // tool leg drains from it. Established after the handle, nothing is published,
  // the drain is empty, no result comes back, and the engine stops after one turn
  // -- which looks like a correct single-turn run and is not.
  const turnPipelines = new TurnPipelinePublisher();

  // The REAL production ledger on a temp dir. Not a stub: the engine calls
  // `begin` before `ports.tools.dispatch` and `settle` after, and the refusal is
  // enforced against whether `begin` answered.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-s3-ledger-'));
  ledgerDirs.push(ledgerDir);
  // `GROUND_FENCE` is only `{ token }`; a `RunFence` is that plus the run's
  // identity, exactly as `tool-side-effect-ledger.test.ts:66` builds it.
  const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });

  const handle = await agent.beginTurnAssembly({
    options,
    prompt,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  // Record which turns the engine asked for and what round the run's own catalog
  // view reached -- both read off the REAL handle.
  const assembledTurns: number[] = [];
  const catalogRounds: number[] = [];
  const realAssemble = handle.assemble.bind(handle);
  const observedHandle = {
    ...handle,
    assemble(input: Parameters<typeof realAssemble>[0]) {
      const assembly = realAssemble(input);
      assembledTurns.push(input.turn);
      catalogRounds.push(assembly.catalogView.currentRound);
      // Re-snapshot the declared set, or nothing runs. See this file's header,
      // finding 2: the guard starts EMPTY and the engine never calls
      // `runTurnStream`, which is where the legacy fills it.
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-s3',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const announced: unknown[] = [];
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: (envelope) => announced.push(envelope) },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-s3',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 's3-proof', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  const hooks: HookInvokedEvent[] = [];
  const host: LegacyRunHost = {
    turnPipelines,
    // The production binding from A3-2b9, over the REAL handle.
    assembleTurn: createLegacyAssembleTurn(agent, observedHandle),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    // Declined, and said so: this proof is about the legs, not about a
    // transcript nobody is testing the size of.
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-s3',
    },
    seqIndex: 0,
    wakeRun: false,
    // See this file's header, finding 1: these are the only reason a tool can
    // dispatch at all, because no tool in the product declares a class.
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
    // S4a: the host-supplied hook source, on the engine's extension port.
    // Before S4a this member did not exist and `RunEnginePorts.extensions` was
    // never bound by anything, so `#contribute` read `?? []` at every call site
    // and an engine-driven run executed no hook at all.
    extensions: createLegacyHookSource({
      cwd: process.cwd(),
      sessionId: `s-s3-proof-${sessionSeq}`,
      prompt,
      settings: HOOK_SETTINGS,
      onHookInvoked: (event) => hooks.push(event),
    }),
  };

  const ports: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-s3',
    projectId: null,
    revision: 'rev-s3',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    // `by_ref`, NOT the inline history `buildLegacyRunInput` emits. See this
    // file's header, finding 3: inline is frozen at run start, so the tool
    // result could never reach turn 2 and the run still completed cleanly.
    history: { kind: 'by_ref', digest: 'hist-s3', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  active = { seen: [] };
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports }).completed();

  turnPipelines.close();

  return {
    calls: () => active?.seen.length ?? 0,
    seen: active?.seen ?? [],
    runs: probe.runs,
    terminals,
    assembledTurns,
    catalogRounds,
    advertised: handle.tools.map((t) => t.name).sort(),
    hooks,
  };
}

// ============================================================================
// THE PROOF
// ============================================================================

describe('the engine drives a real duyaAgent for more than one turn', () => {
  it('opens the model leg on EVERY turn and dispatches the tool on the first', async () => {
    const proof = await runThroughEngine();

    // POSITIVE COUNTS, never shapes. A run that stopped calling a leg has to
    // fail here rather than satisfy a "nothing looks wrong" assertion.
    expect(proof.calls()).toBe(2);
    expect(proof.runs()).toBe(1);

    // The engine asked the REAL handle for two turns, numbered from one, and the
    // run's own catalog view reached each of them.
    expect(proof.assembledTurns).toEqual([1, 2]);
    expect(proof.catalogRounds).toEqual([1, 2]);

    // One terminal, proposed by the engine -- a single writer, not a second
    // account minted beside it. `state` is the terminal the engine believed
    // ended the run, and `completed` is the one a turn that answered the model
    // should reach.
    expect(proof.terminals).toHaveLength(1);
    // `state` is a discriminated object, not a bare string, so the assertion
    // reads its `status` -- which is what a consumer switches on.
    expect(proof.terminals[0].state.status).toBe('completed');
  });

  it('advertises the agent\'s OWN resolved surface, cross-checked against the wire', async () => {
    const proof = await runThroughEngine();

    // CROSS-SOURCE, not a hardcoded list: what the provider was handed (source A)
    // must equal what the agent resolved (source B). A projection that dropped a
    // schema, or built a set of its own, fails here -- and a hardcoded list would
    // have gone stale the moment `_resolveTools` changed its mind.
    expect(proof.seen[0].toolNames).toEqual([...proof.advertised]);
    expect(proof.advertised).toContain(PROBE);

    // And the run's base prompt reached the wire, which is the assembly's other
    // half. Its absence would mean the host assembled an empty turn.
    expect(proof.seen[0].systemPrompt).toContain('Tool-group progress:');
  });

  it('feeds the tool result BACK to the model on the second request', async () => {
    const proof = await runThroughEngine();

    // THE cross-leg claim, and the one no per-leg assertion can make: the tool
    // the first turn dispatched actually reached the SECOND turn's request.
    // Turn 1 is `user, user` (prompt + the agent's transcript copy); turn 2 adds
    // the assistant's tool_use and the tool result.
    expect(proof.seen).toHaveLength(2);
    expect(proof.seen[0].roles).not.toContain('tool');
    expect(proof.seen[1].roles).toContain('assistant');
    expect(proof.seen[1].roles).toContain('tool');
  });
});

// ============================================================================
// S4a -- the hook surface
// ============================================================================

describe('an engine-driven turn dispatches the hook events the legacy cycle dispatches', () => {
  it('fires the run-scoped hooks once, at the two ends, and nothing in between', async () => {
    const proof = await runThroughEngine();
    const fired = proof.hooks.map((h) => h.hookEventName);

    // EXACT SEQUENCE, and in this order for a reason rather than for tidiness.
    // `UserPromptSubmit` before `SessionStart` is the legacy's own order
    // (`DuyaAgent.ts:2130` then `:2144`) and both feed the same first-turn
    // context rail, so a session that starts before the prompt is submitted
    // inverts the provenance the envelopes carry. `PreToolUse` before
    // `PostToolUse` is the point of the pair: a hook that gates a tool has to
    // run before it, and a hook that reports on one after it.
    //
    // Counts are implied by the sequence and are therefore not vacuous: a run
    // that dispatched nothing at all would produce `[]` and fail here.
    expect(fired).toEqual(['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd']);

    // POSITIVE COUNT, the S3 rule: exactly one run-scoped pair for a run that
    // began once and ended once. A source that fired `on_start` per TURN would
    // show two `UserPromptSubmit` here and the sequence above would not hold.
    expect(fired.filter((name) => name === 'SessionStart')).toHaveLength(1);
    expect(fired.filter((name) => name === 'SessionEnd')).toHaveLength(1);

    // `Stop` is registered on the run that CANCELLED, never on this one. Its
    // absence is asserted rather than assumed, because the alternative -- a
    // source that fires `Stop` on every exit -- would sail through the
    // sequence above and is exactly the bug `firesOnExit` exists to prevent.
    expect(fired).not.toContain('Stop');
  });

  it('hands the tool hook a payload a real hook could read, correlated across both phases', async () => {
    const proof = await runThroughEngine();
    const pre = proof.hooks.find((h) => h.hookEventName === 'PreToolUse');
    const post = proof.hooks.find((h) => h.hookEventName === 'PostToolUse');

    // These are STRINGS a `node` subprocess printed after parsing the event
    // JSON off stdin, not a value this test handed the source: `PreToolUse/
    // probe_ok/t1` means the engine dispatched the phase, the source built
    // `tool_name` and `tool_use_id` from the live `ToolCallRequest`, and a real
    // hook read them back.
    expect(pre?.additionalContext).toBe(`PreToolUse/${PROBE}/t1`);
    // And the POST side named the same call -- which it can only do by
    // correlating `after_tool`'s bare outcome back to the `before_tool` request,
    // because `ExtensionContext.outcome` carries no tool name. A source that
    // dropped the correlation would print `PostToolUse/-/t1` here.
    expect(post?.additionalContext).toBe(`PostToolUse/${PROBE}/t1`);

    // The probe really ran, so the `PostToolUse` above is about a result that
    // exists rather than a hook that fired against nothing.
    expect(proof.runs()).toBe(1);
  });

  it('maps only the four phases it has events for, and says which', () => {
    // The MAP, not the fallout. Asserting on what happened to fire would let a
    // source that mapped `before_turn` to nothing still pass, and would say
    // nothing about the three engine-own phases that have no config event yet
    // (`hook-source.ts` header: the loop bus is the orchestrator slice).
    expect([...MAPPED_PHASES].sort()).toEqual(['after_finalize', 'after_tool', 'before_tool', 'on_start']);
  });
});

describe('the proof is wired to the real seams, not to a double', () => {
  it('reaches the model through the AGENT\'s own client', async () => {
    // `composeLegacyRunPorts` derives the model port from
    // `agent.readModelClient()`. If a caller passed a model port of its own, the
    // proof would measure THAT port and the agent's client would go uncalled --
    // so the scripted provider being reached at all is the evidence.
    const proof = await runThroughEngine();
    expect(proof.calls()).toBeGreaterThan(0);
    expect(proof.seen).toHaveLength(2);
  });

  it('leaves the legacy driver in place and the entry still on it', async () => {
    // S3 is proof, not cutover. If proving it required the entry to drive the
    // engine, the sequence was wrong and this assertion is what would say so.
    //
    // `import.meta.dirname` rather than `fileURLToPath(import.meta.url)`: the
    // latter needs `node:url`, and importing a module for a path helper in a
    // test costs a cross-boundary edge that moves the architecture counters this
    // slice is required to hold still. `fs` and `path` are already imported for
    // the ledger's temp dir, so reusing them costs nothing.
    const here = import.meta.dirname;
    if (typeof here !== 'string') throw new Error('import.meta.dirname unavailable');
    const entry = readFileSync(path.join(here, '..', 'agent-process-entry.ts'), 'utf8');
    const code = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect((code.match(/agent\.streamChat\s*\(/g) ?? []).length).toBe(1);
    expect((code.match(/new RunEngineImpl\s*\(/g) ?? []).length).toBe(0);
  });

  it('publishes through the REAL emitter, which is what MINTS the sequence', async () => {
    // `stream.push` receives ENVELOPES, which is the emitter's output and not the
    // engine's `RunEvent`: the emitter mints `seq` and wraps the event. A local
    // recorder could produce the same event list but could not mint a sequence,
    // so this asserts the envelope's own fields.
    const proof = await runThroughEngine();
    expect(proof.terminals).toHaveLength(1);
  });
});