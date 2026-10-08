/**
 * Plan 610 P1: an HONEST first-attempt fence, and the tool leg it unblocks.
 *
 * ## The gap this file closes
 *
 * `RunEngineImpl.#ticket` refuses to dispatch any tool that is not `read_only`
 * when no side-effect ledger is attached, and `composeLegacyRunSources` derives
 * `sideEffectOf: () => null` for every tool, which `resolveSideEffectClass`
 * turns into `undeclared`. So with no ledger, EVERY dispatch in the product is
 * refused and the run ends `failed` with zero tool executions. The ledger is
 * not an optimisation here; it is what makes the tool leg reachable at all.
 *
 * ## Why the fence was the thing blocking it
 *
 * Binding a ledger takes a `runEpoch` and a `RunFence` (`LedgerOptions`), and
 * the worker's first attempt had neither. The runtime's only fence producer,
 * `recoverRun`, mints a fence for an epoch+1 RECOVERY and requires an
 * already-committed checkpoint -- so there was no honest epoch-1 fence to bind,
 * and every existing supplier fabricated one out of the two exported constants
 * `FIRST_EPOCH` and `GROUND_FENCE`.
 *
 * A fabricated fence is not a smaller problem than no fence. It satisfies the
 * type, so a crash of a RESUMED run would present as a duplicate dispatch
 * rather than an unattributable effect -- which is the distinction the ledger
 * exists to keep. `firstAttemptFence` derives the value from durable state
 * instead, and REFUSES when the state says an earlier attempt exists.
 *
 * ## What is real here
 *
 * REAL: the `duyaAgent`; `beginTurnAssembly` / `assembleTurn`; the permission
 * gate; the `ToolExecutionPipeline` and its executor; `TurnPipelinePublisher`;
 * `createToolSideEffectLedger` on a real temp dir; `composeLegacyRunPorts` and
 * every port it binds; the `RunEngineImpl` loop; `RunSession`; `RunEventEmitter`.
 *
 * FAKED, and only these two: the PROVIDER (scripted, because a proof needs a
 * model that answers on cue) and the worker's DB IPC (mode state + mailbox
 * claim). Neither replaces a leg under test.
 *
 * ## The trap this file is built to avoid
 *
 * A fixture that never dispatches anything satisfies "the run did not fail"
 * vacuously -- the trap `turn-pipeline-producer.test.ts` documents, where a
 * MUTE pipeline passes a "nothing was dispatched" assertion. So the headline
 * assertion is a POSITIVE COUNT of real executions (`runs() === 1`), and the
 * no-ledger arm is asserted to be ZERO, which is what makes the positive count
 * mean something: the same harness, the same tool, the same script, differing
 * only in whether an honest fence licensed a ledger.
 *
 * That arm pair is also the anti-fabrication check. The no-ledger arm cannot be
 * made to pass by loosening anything -- it is the engine's own refusal, and it
 * is asserted as a POSITIVE zero.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firstAttemptFence } from '@duya/agent-protocol';
import type { RunId } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import type { RunEnginePorts, RunInputSnapshot, TerminalCandidate } from '@duya/agent-runtime';
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

// ============================================================================
// The scripted PROVIDER -- the only fake standing in for a leg's far end
// ============================================================================

interface Seen {
  readonly roles: readonly string[];
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
      // Read the turn index BEFORE recording, or turn 1 indexes -1 and replays
      // the LAST script -- a fixture that silently drops the tool call and
      // makes the whole file pass without ever dispatching a tool.
      const index = active?.seen.length ?? 0;
      active?.seen.push({ roles: messages.map((m) => m.role) });
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
const { createToolSideEffectLedger } = await import('../tool-side-effect-ledger.js');
const { RunEngineImpl, RunEventEmitter, RunSession } = await import('@duya/agent-runtime');

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

/** Ledger temp dirs, removed after each test so a failing run leaves nothing. */
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's
 * own listener is called directly -- the pool's would try to deserialize a
 * plain object as a Buffer.
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
 * Not into a registry handed to `_resolveTools`. The engine's side-effect
 * lookup is derived from `agent.activeMCPRegistry`, so a probe living only in
 * `options.toolRegistry` is invisible to it and every call resolves
 * `undeclared`. Registering where the catalog actually is also makes the
 * advertised surface the agent's REAL one rather than a fixture's.
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

let sessionSeq = 0;

interface Proof {
  readonly runs: () => number;
  readonly terminals: readonly string[];
  readonly calls: () => number;
  /** The fence the ledger was bound with, as the PROTOCOL minted it. */
  readonly fenceToken: number;
}

/**
 * Drive one real engine-driven run.
 *
 * `attachLedger` is the whole experiment. TRUE binds a ledger on a fence from
 * `firstAttemptFence`; FALSE omits `beginTicket`/`settleTicket` entirely, which
 * is the arm the product is in today because nothing honest licensed one.
 */
async function runThroughEngine(attachLedger: boolean): Promise<Proof> {
  installFakeDbIpc();

  sessionSeq += 1;
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-p1-fence-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  // The live run's setup, in the order the legacy sets it up. `streamChat`
  // normally owns this; a host driving the engine does it instead, which is
  // precisely what makes the engine-driven path a HOST decision.
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const probe = registerProbe(agent);

  const turnPipelines = new TurnPipelinePublisher();
  const prompt = 'run the probe';
  const options = { sessionId: `s-p1-fence-${sessionSeq}` } as never;
  const turnContext = agent.assembleTurnContext(options, prompt);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const handle = await agent.beginTurnAssembly({
    options,
    prompt,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });
  const realAssemble = handle.assemble.bind(handle);
  const observedHandle = {
    ...handle,
    assemble(input: Parameters<typeof realAssemble>[0]) {
      const assembly = realAssemble(input);
      // Re-snapshot the declared set, or nothing dispatches: the visibility
      // guard starts EMPTY and the engine never calls `runTurnStream`, which is
      // where the legacy fills it.
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const runId = 'run-p1-fence' as RunId;
  const session = new RunSession({
    runId,
    sessionId: 'sess-p1-fence',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const terminals: TerminalCandidate[] = [];
  const emitter = new RunEventEmitter({ runId, session, stream: { push: () => undefined } });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-p1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'p1-fence', version: '0.0.0' },
  });

  // The fence comes from the PROTOCOL, derived from durable state, and never
  // from the two exported constants by hand. `committed: false` is the claim
  // "this run has no earlier attempt", and a temp dir nobody has written to is
  // the state that actually justifies it.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-p1-fence-'));
  ledgerDirs.push(ledgerDir);
  const fence = firstAttemptFence({ runId, state: { committed: false } });
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId,
    runEpoch: fence.runEpoch,
    fence,
  });

  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(observedHandle),
    // Required on the host, and satisfied from the SAME handle the wrapper
    // above closes over -- one guard, one owner, no second copy. The wrapper's
    // own refresh is kept deliberately: this file's claim is about the FENCE,
    // and it must not move when the declared-tools plumbing lands. Two
    // identical refreshes replace the snapshot with the same set, so keeping
    // both costs nothing and keeps the two slices independently verifiable.
    refreshDeclaredTools: () => observedHandle.refreshDeclaredTools(),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-p1',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId: `s-p1-fence-${sessionSeq}`,
    workingDirectory: process.cwd(),
    // The ONLY difference between the two arms. With no honest fence licensed
    // one, a host omits these and the engine refuses every dispatch.
    ...(attachLedger
      ? { beginTicket: (call) => ledger.begin(call), settleTicket: (input) => ledger.settle(input) }
      : {}),
  } as LegacyRunHost;

  const ports: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-p1-fence',
    projectId: null,
    revision: 'rev-p1',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  } as LegacyRunFacts;

  active = { seen: [] };
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    // `by_ref`, NOT the inline history `buildLegacyRunInput` emits: inline is
    // frozen at run start, so the tool result could never reach turn 2 and the
    // run would still complete cleanly. Irrelevant to the count this file
    // asserts, and stated so the divergence is not mistaken for the claim.
    history: { kind: 'by_ref', digest: 'hist-p1', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({
    manifest: buildLegacyRunManifest(facts),
    input,
    signal: new AbortController().signal,
    ports,
  }).completed();

  turnPipelines.close();

  return {
    runs: probe.runs,
    terminals: terminals.map((candidate) => candidate.state.status),
    calls: () => active?.seen.length ?? 0,
    fenceToken: fence.token,
  };
}

// ============================================================================
// THE PROOF
// ============================================================================

describe('an honest first-attempt fence makes the tool leg reachable', () => {
  it('executes the tool when the ledger is bound on a derived first-attempt fence', async () => {
    const proof = await runThroughEngine(true);

    // THE POSITIVE COUNT. A run that quietly stopped dispatching has to fail
    // here rather than satisfy a "nothing looks wrong" assertion -- the trap
    // this file's header names.
    expect(proof.runs()).toBe(1);

    // And the run reached a real terminal, so the execution did not come with a
    // dead run behind it.
    expect(proof.terminals).toEqual(['completed']);

    // The model leg ran too, so "one tool execution" is a turn that happened
    // rather than a dispatch that bypassed the loop.
    expect(proof.calls()).toBe(2);
  });

  it('executes NOTHING and fails when no fence licensed a ledger', async () => {
    // The arm the product is in today. Asserted as a POSITIVE ZERO, because
    // this is the engine's own refusal (`RunEngineImpl.#ticket`: no ledger and
    // a non-`read_only` class is refused) and not an accident of the fixture.
    // It is what gives the positive count in the arm above its meaning: same
    // harness, same tool, same script, differing only in the fence.
    const proof = await runThroughEngine(false);

    expect(proof.runs()).toBe(0);
    expect(proof.terminals).toEqual(['failed']);
  });

  it('refuses to mint a first-attempt fence once an earlier attempt committed one', async () => {
    // The anti-fabrication half, and the reason this is a producer rather than
    // a constant. A resumed run must not receive a shape-valid fence that a
    // crash could not tell apart from its dead predecessor's -- the ledger
    // needs "unattributable" to stay distinguishable from "duplicate".
    expect(() =>
      firstAttemptFence({
        runId: 'run-p1-fence' as RunId,
        state: { committed: true, committedFence: 7 },
      }),
    ).toThrow(/already committed fence 7/);
  });
});
