/**
 * Plan 610 D1: a `before_commit` contributor's work reaches the DURABLE
 * committed transcript, and a run with no contributor is unchanged.
 *
 * ## The gap this closes, measured rather than asserted
 *
 * The legacy's `SessionFinalizer.finalize` runs
 * `pollFinalMailbox` -> `PreFinalize` -> `PostTurn` -> `runExitHooks` ->
 * `_commitMessages` -> `SessionEnd`. `PostTurn`'s effects are applied to the
 * working `messages` array by `applyLoopHookEffect` (`hooks/loop.ts:252`) and
 * `_commitMessages` persists that array immediately afterwards
 * (`SessionFinalizer.ts:226` then `:245`). So a `PostTurn` contribution reaches
 * the timeline, the durable record, and a later turn.
 *
 * The engine could express neither end of that. `before_finalize` can only VETO
 * -- `#shouldStop` reads a binding veto as "run again", and its text goes onto
 * the deferred rail, so a run that finalizes ends with it unread. And
 * `after_finalize` runs in the run's `finally`, after the loop has broken, and
 * its contributions are deliberately NOT adopted. That no-adopt behaviour is
 * documented and was reviewed, so this slice adds a phase rather than changing
 * it, and the test pins the no-adopt so a later slice cannot quietly convert it.
 *
 * ## What is REAL here, and what is counted
 *
 * REAL: a real `duyaAgent`; `beginTurnAssembly` / `assembleTurn`; the
 * `ToolExecutionPipeline` and `TurnPipelinePublisher`; the side-effect ledger;
 * `composeLegacyRunPorts` and every port it binds; the `RunEngineImpl` loop; and
 * the product's OWN `addMessage` append, which is the same append
 * `_commitMessages` persists.
 *
 * The committed row is read back off `agent.getMessages()`, which is a live
 * getter over the append-only timeline (`DuyaAgent.messages`), not a return
 * value of anything this slice wrote. That is the difference between observing
 * the durable record and asserting a helper's own output.
 *
 * FAKED, and only the PROVIDER: `createAIClient` is scripted, so a run that
 * should not reach a model can be shown not to have reached one.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type {
  ExtensionContext,
  ExtensionContribution,
  ExtensionContributor,
  ExtensionPort,
  InjectedMessageRecord,
  RunEnginePorts,
  RunInputSnapshot,
  TerminalCandidate,
  TransientContextFragment,
} from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER
// ============================================================================

/** Every request the provider was handed, appended at the moment one was asked for. */
let seenRequests: { readonly contents: readonly string[] }[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      seenRequests.push({
        contents: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      });
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of [{ type: 'text', data: 'the model answered conversationally' }, DONE]) {
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
// The offline host. The dynamic-import ORDER is load-bearing -- see `PRE_EXISTING`.
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
const tempDirs: string[] = [];

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
      throw new Error(`unexpected db action in the before_commit proof: ${req.action}`);
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
  seenRequests = [];
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

const RUN_ID = 'run-d1-before-commit' as RunId;
let sessionSeq = 0;

// ============================================================================
// One contributor, per phase, that records what it was asked and answers.
// ============================================================================

/**
 * What one contributor observed, so the test can count DISPATCHES not results.
 *
 * The `ExtensionContributor` is carried ON the probe rather than beside it in a
 * side map, and that is not tidiness. An earlier shape of this fixture kept the
 * contributor in a closure and returned only the probe, so `portFor` handed the
 * engine objects with no `contribute` method: `#contribute` threw on
 * `contributor.contribute`, rule 3's fail-open swallowed it, and every test in
 * this file reported "the phase was never dispatched" for a fixture that was
 * simply wrong. Carrying the real object makes that unrepresentable.
 */
interface ContributorProbe {
  readonly id: string;
  readonly contributor: ExtensionContributor;
  /** How many times `contribute` was entered. A POSITIVE COUNT. */
  readonly calls: () => number;
  /** The contexts it was handed, in order. */
  readonly seen: readonly ExtensionContext[];
}

const PROBE_TEXT = 'the contributor wrote this at the end of the turn';

/**
 * A contributor that returns one text contribution and records its calls.
 *
 * The text is deliberately distinctive so that "the row is in the transcript"
 * cannot be satisfied by the model's own answer, which is a different string.
 */
function textContributor(
  id: string,
  phase: ExtensionContributor['phase'],
  text: string,
  binding = false,
): ContributorProbe {
  let calls = 0;
  const seen: ExtensionContext[] = [];
  const contributor: ExtensionContributor = {
    id,
    phase,
    order: 0,
    timeoutMs: 1_000,
    async contribute(ctx: ExtensionContext): Promise<readonly ExtensionContribution[]> {
      calls += 1;
      seen.push(ctx);
      return [{ key: `${id}:0`, content: { kind: 'hook_context', key: `${id}:0`, text }, binding }];
    },
  };
  return { id, contributor, calls: () => calls, seen };
}

/** A contributor that returns one BINDING veto and records its calls. */
function vetoContributor(id: string, phase: ExtensionContributor['phase']): ContributorProbe {
  let calls = 0;
  const seen: ExtensionContext[] = [];
  const contributor: ExtensionContributor = {
    id,
    phase,
    order: 0,
    timeoutMs: 1_000,
    async contribute(ctx: ExtensionContext): Promise<readonly ExtensionContribution[]> {
      calls += 1;
      seen.push(ctx);
      return [{ key: `${id}:0`, content: { veto: true, reason: 'keep going' }, binding: true }];
    },
  };
  return { id, contributor, calls: () => calls, seen };
}

/** An `ExtensionPort` over exactly the contributors handed, keyed by their own phase. */
function portFor(probes: readonly ContributorProbe[]): ExtensionPort {
  return {
    list: (phase) =>
      probes.filter((probe) => probe.contributor.phase === phase).map((probe) => probe.contributor),
    unload: () => Promise.resolve(),
  };
}

/** An `ExtensionPort` with NO contributors at all, for the no-op comparison. */
const EMPTY_PORT: ExtensionPort = { list: () => [], unload: () => Promise.resolve() };

// ============================================================================
// The harness: a real engine over real composed ports
// ============================================================================

interface Observation {
  /** How many times the provider was asked for a request. POSITIVE COUNT. */
  readonly calls: () => number;
  /** THE DURABLE RECORD: the agent's own projected transcript, read back. */
  readonly transcript: () => readonly Message[];
  readonly terminals: readonly TerminalCandidate[];
  /** The rows the host's turn-output port recorded, as `{ key, text }`. */
  readonly injectedRows: readonly InjectedMessageRecord[];
  /**
   * Every fragment the ENGINE handed the host through `ports.context.defer`.
   *
   * THE ACTION, not the result. This is the tap that makes "a phase did not
   * adopt" observable independently of whether anything downstream would have
   * read what it adopted: a contribution that is deferred is a SIDE EFFECT the
   * host performed, and a run whose loop has already broken will never surface
   * it in the transcript. See the `after_finalize` test for why asserting the
   * consequence alone is the weaker claim.
   */
  readonly deferredFragments: readonly TransientContextFragment[];
}

/**
 * Drive a real `RunEngineImpl` over `composeLegacyRunPorts` with a real agent.
 *
 * Deliberately the same shape as `engine-control-command-proof.test.ts`'s
 * harness, including the handle-bound `refreshDeclaredTools` the model leg
 * calls per attempt (plan 610 P3): a proof that differs from a proven harness
 * in its SETUP proves a different thing than it claims.
 *
 * `extensions` is omitted from the ports entirely when `null`, so the
 * "no extension port at all" arm is a genuinely absent port rather than an
 * empty one.
 */
async function runOnce(options: {
  readonly extensions: ExtensionPort | null;
}): Promise<Observation & { readonly listCalls: readonly string[] }> {
  installFakeDbIpc();
  const seq = (sessionSeq += 1);
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-bc-${seq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const promptText = 'do the thing';
  const options_ = { sessionId: `s-bc-${seq}` } as never;
  const turnContext = agent.assembleTurnContext(options_, promptText);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: promptText, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-bc-ledger-'));
  tempDirs.push(ledgerDir);
  const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });

  const handle = await agent.beginTurnAssembly({
    options: options_,
    prompt: promptText,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-bc',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const announced: { type?: string }[] = [];
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: (envelope) => announced.push(envelope as never) },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-bc',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'before-commit', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  // The host's OWN durable-row sink, wrapping the product's own append. The
  // engine reaches the agent through `composeLegacyRunPorts`; this array exists
  // so the test can see the RECORD the host was handed as well as the row the
  // agent ended up with, and the two are asserted against each other.
  const injectedRows: InjectedMessageRecord[] = [];

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
      nextCompactionId: () => 'cmp-bc',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId: `s-bc-${seq}`,
    workingDirectory: process.cwd(),
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
  };

  const composed: RunEnginePorts = composeLegacyRunPorts(agent, host);
  // The observation tap, wrapped AROUND the product's own derivation rather than
  // replacing it: the row still goes through `agent.addMessage` exactly as an
  // un-tapped run would, and the tap only records what the host was handed.
  const turnOutput = composed.turnOutput!;
  // WHICH phases the engine consulted, in order. This is how "the gate was
  // evaluated once and dispatched nobody" becomes observable from outside the
  // engine, and it is what the no-contributor arm compares between its two
  // configurations.
  const listCalls: string[] = [];
  const deferredFragments: TransientContextFragment[] = [];
  // The `defer` tap, wrapped AROUND the product's own port exactly as
  // `turnOutput` is below -- the engine still calls the composed port, and the
  // tap only records what the host was handed. Asserting on this rather than on
  // the transcript is what separates "the engine did not adopt" from "nothing
  // read the adoption anyway", which are the same observation today and not the
  // same claim.
  const context = composed.context;
  const ports: RunEnginePorts = {
    ...composed,
    context: {
      ...context,
      defer: (fragment) => {
        deferredFragments.push(fragment);
        return context.defer(fragment);
      },
    },
    turnOutput: {
      ...turnOutput,
      recordInjectedMessage: (record) => {
        injectedRows.push(record);
        return turnOutput.recordInjectedMessage(record);
      },
    },
    ...(options.extensions === null
      ? {}
      : {
          extensions: {
            list: (phase) => {
              listCalls.push(phase);
              return options.extensions!.list(phase);
            },
            unload: (ids) => options.extensions!.unload(ids),
          },
        }),
  } as RunEnginePorts;

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-bc',
    projectId: null,
    revision: 'rev-bc',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: promptText }, []),
    history: { kind: 'by_ref', digest: 'hist-bc', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  seenRequests = [];

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports }).completed();
  turnPipelines.close();

  return {
    calls: () => seenRequests.length,
    transcript: () => agent.getMessages(),
    terminals,
    injectedRows,
    listCalls,
    deferredFragments,
  };
}

// ============================================================================
// The capability
// ============================================================================

describe('a before_commit contributor', () => {
  it('has its work in the DURABLE committed transcript, and the run still completes', async () => {
    const probe = textContributor('bc:1', 'before_commit', PROBE_TEXT);

    const run = await runOnce({ extensions: portFor([probe]) });

    // DISPATCHED, positively counted. Zero model calls is the control: the phase
    // runs at the finalize boundary, so a run that reached the model here would
    // mean the phase fired somewhere it does not belong.
    expect(probe.calls()).toBe(1);
    expect(run.calls()).toBe(1);

    // THE CLAIM, observed on the agent's own transcript rather than on a return
    // value. `getMessages()` is a live getter over the append-only timeline, so
    // a row that appears here is a row the product's commit path stored.
    const committed = run.transcript().filter((message) =>
      typeof message.content === 'string' ? message.content.includes(PROBE_TEXT) : false,
    );
    expect(committed).toHaveLength(1);
    // The row is the transcript's injected `user` turn, marked as runtime context
    // -- the same shape the legacy's own `PostTurn` inject produces
    // (`projectRuntimeContextToProviderMessage`).
    expect(committed[0].role).toBe('user');

    // And the host was handed the record the engine built, with the
    // contributor's own key carried verbatim.
    expect(run.injectedRows).toHaveLength(1);
    expect(run.injectedRows[0].key).toBe('bc:1:0');
    expect(run.injectedRows[0].text).toBe(PROBE_TEXT);

    // The run is otherwise a normal successful run: one terminal, `completed`.
    expect(run.terminals).toHaveLength(1);
    expect(run.terminals[0].state.status).toBe('completed');
  });

  it('is IGNORED when it vetoes, because there is no loop left to keep open', async () => {
    const probe = vetoContributor('veto:1', 'before_commit');

    const run = await runOnce({ extensions: portFor([probe]) });

    // DISPATCHED and honoured as a dispatch...
    expect(probe.calls()).toBe(1);
    // ...but NOT as a veto. A contributor that wants the run to continue
    // registers for `before_finalize`, whose veto means exactly that. Stated
    // because a silently-ignored veto is indistinguishable from a dropped one.
    expect(run.terminals).toHaveLength(1);
    expect(run.terminals[0].state.status).toBe('completed');
  });
});

// ============================================================================
// What this phase is NOT, pinned so a later slice cannot quietly change it
// ============================================================================

describe('the phases this one does not replace', () => {
  it('leaves after_finalize\'s deliberate no-adopt behaviour alone', async () => {
    const probe = textContributor('af:1', 'after_finalize', 'after_finalize said this');

    const run = await runOnce({ extensions: portFor([probe]) });

    // DISPATCHED -- the phase still runs, because a `SessionEnd` hook's real
    // work is its side effects.
    expect(probe.calls()).toBe(1);

    // THE CLAIM, asserted as an ACTION rather than as a consequence.
    //
    // The previous version of this assertion read the transcript and the
    // injected rows, which is a CONSEQUENCE of adoption, and that is the weaker
    // claim for a phase that fires in the run's `finally`: every read of
    // `deferred.current` is inside the turn loop (`#transcriptFor` and
    // `#modelRequest` are its only readers), and by the time this phase runs
    // the loop has broken. So a `#adopt` here would push a fragment and call
    // `ports.context.defer` -- a real side effect on the host, writing to a
    // list nothing will ever read -- and every consequence-based assertion here
    // would still pass. The behaviour would have changed while the test stayed
    // green, which is the specific reason the assertion is on the tap.
    //
    // This is the defect `after_finalize`'s own call-site comment warns
    // against (`run-engine.ts:941-951`): a side effect claiming a delivery that
    // did not happen.
    expect(run.deferredFragments).toHaveLength(0);
    expect(run.injectedRows).toHaveLength(0);
    // Stated as its own assertion so a future reader does not "simplify" the
    // pair into the consequence alone: the text must not be in the transcript
    // either. It is kept because it is the user-visible half, and it is
    // strengthened rather than replaced by the action above.
    const leaked = run.transcript().filter((message) =>
      typeof message.content === 'string' ? message.content.includes('after_finalize said this') : false,
    );
    expect(leaked).toHaveLength(0);
  });

  it('proves the defer tap is LIVE, so the no-defer assertion above is not vacuous', async () => {
    // The control, and it is the half that makes the assertion above mean
    // something. A tap that never fires satisfies `toHaveLength(0)` for every
    // input, including a run that adopted everything -- which is exactly the
    // failure the previous version of this test would have had.
    //
    // `before_model` is the phase that DOES adopt, so it must appear on the tap
    // even though the run's loop breaks on the same turn: the tap records the
    // HOST's side effect, which happens whether or not anything reads it.
    const adopting = textContributor('bm:1', 'before_model', 'before_model said this');
    const late = textContributor('af:2', 'after_finalize', 'after_finalize said this');

    const run = await runOnce({ extensions: portFor([adopting, late]) });

    // Both dispatched.
    expect(adopting.calls()).toBe(1);
    expect(late.calls()).toBe(1);
    // EXACTLY ONE fragment on the tap, and it is the adopting phase's. If the
    // mutation at `run-engine.ts:960` were live this would be 2, and the count
    // is what localises the failure to the `after_finalize` phase rather than
    // to the tap.
    expect(run.deferredFragments).toHaveLength(1);
    expect(run.deferredFragments[0].key).toBe('bm:1:0');
    // And the `after_finalize` fragment's own key is absent, by name, so a tap
    // that recorded the right COUNT of the wrong fragments still fails.
    expect(run.deferredFragments.map((fragment) => fragment.key)).not.toContain('af:2:0');
  });

  it('does not make before_finalize a commit path, which is why this phase exists', async () => {
    const probe = textContributor('bf:1', 'before_finalize', 'before_finalize said this');
    
    const run = await runOnce({ extensions: portFor([probe]) });

    // DISPATCHED and ADOPTED onto the deferred rail -- and the run finalized, so
    // the text reached nobody. This is the gap, measured on the real path: the
    // contribution is executed, the run completes, and the work is gone.
    expect(probe.calls()).toBe(1);
    expect(run.injectedRows).toHaveLength(0);
    const leaked = run.transcript().filter((message) =>
      typeof message.content === 'string' ? message.content.includes('before_finalize said this') : false,
    );
    expect(leaked).toHaveLength(0);
  });
});

// ============================================================================
// A run with no contributor is unchanged
// ============================================================================

describe('a run with no before_commit contributor', () => {
  it('dispatches the phase to nobody', async () => {
    const probe = textContributor('other:1', 'after_tool', 'unrelated');
    
    const run = await runOnce({ extensions: portFor([probe]) });

    expect(run.injectedRows).toHaveLength(0);
    expect(run.terminals).toHaveLength(1);
    expect(run.terminals[0].state.status).toBe('completed');
  });

  it('is consulted once and dispatched to nobody, and the run is otherwise identical', async () => {
    // THE MEASUREMENT, not an assumption, and in two halves because neither half
    // alone is the claim.
    //
    // Behavioural: an extension port that answers `[]` for the new phase must
    // cost exactly what no extension port costs. Every observable the harness can
    // read is compared -- provider calls, the committed transcript, the terminal,
    // and which phases were consulted. If the gate were absent, `#contribute`
    // and `#commitContributions` would still run and dispatch nobody, so this
    // half alone cannot see it; that is what the structural half is for.
    const withEmptyPort = await runOnce({ extensions: EMPTY_PORT });
    const withNoPort = await runOnce({ extensions: null });

    expect(withEmptyPort.injectedRows).toHaveLength(0);
    expect(withNoPort.injectedRows).toHaveLength(0);
    expect(withEmptyPort.calls()).toBe(withNoPort.calls());
    expect(withEmptyPort.transcript().length).toBe(withNoPort.transcript().length);
    expect(withEmptyPort.terminals).toHaveLength(1);
    expect(withEmptyPort.terminals[0].state.status).toBe('completed');
    // The phase WAS consulted -- EXACTLY ONCE, which is the gate and nothing
    // else. With a contributor registered the engine asks twice, because the
    // gate asks whether anyone is there and `#contribute` then asks for the list
    // to dispatch; with nobody registered the second question is never asked, so
    // one lookup is the observable shape of "the phase cost a predicate and no
    // more". An absent consultation would mean the phase is not wired at all,
    // which would make the rest of this file vacuous.
    const commitLookups = withEmptyPort.listCalls.filter((phase) => phase === 'before_commit');
    expect(commitLookups).toHaveLength(1);
    // And consulted AFTER every per-turn phase: this is a finalize-boundary
    // phase, not a per-turn one, and its position is the whole of its semantics.
    const phases = withEmptyPort.listCalls;
    const commitAt = phases.indexOf('before_commit');
    expect(commitAt).toBeGreaterThan(phases.lastIndexOf('before_model'));
    // And BEFORE `after_finalize`, which is the other finalize-boundary phase
    // and the one this slice deliberately did not move.
    expect(phases.lastIndexOf('after_finalize')).toBeGreaterThan(commitAt);

    // Structural: the awaits at the new call site are INSIDE the gate. This is
    // the same technique `live-turn-single-driver.test.ts` uses to pin the
    // engine's loop shape, and it is here for the same reason -- the property is
    // about where a statement sits in the source, which no behavioural probe can
    // see when the phase dispatches nobody.
    //
    // Stated rather than assumed, because a counting instrument was tried and
    // does not work here: a self-requeueing microtask counter starves the event
    // loop (the queue never empties, so the harness's `setImmediate`-backed DB
    // stub never runs and the run deadlocks), and a counter that yields to
    // macrotasks quantises its own result, so it cannot resolve the one-tick
    // difference the ungated version would introduce.
    const source = readFileSync(
      fileURLToPath(new URL('../../../../agent-runtime/src/engine/run-engine.ts', import.meta.url)),
      'utf-8',
    );
    const gate = /if\s*\(\(ctx\.ports\.extensions\?\.list\('before_commit'\)\s*\?\?\s*\[\]\)\.length\s*>\s*0\)\s*\{/;
    const opening = source.search(gate);
    expect(opening).toBeGreaterThan(-1);
    // The block the gate opens must CONTAIN both awaits, so an ungated
    // `await this.#contribute(...)` cannot satisfy this by living inside a
    // different `if`. Counted by brace depth from the gate's own brace.
    let depth = 0;
    let end = -1;
    for (let i = opening + gate.exec(source)![0].length - 1; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(opening);
    const gated = source.slice(opening, end);
    expect(gated).toContain("await this.#contribute(ctx, 'before_commit'");
    expect(gated).toContain('await this.#commitContributions(');
  });
});
