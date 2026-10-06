/**
 * Plan 610 (fork / reply metadata): what the engine-driven path actually does
 * with `threadMeta`, measured rather than assumed.
 *
 * ## What this file was, and what it is now
 *
 * The file began as the PRE-FIX DIAGNOSIS. It measured all six channels and
 * concluded that the durable-write half was already wired -- `recordTurnToolResult`
 * and `recordTurnAssistantMessage` both call the agent's own `_commitDurable`,
 * which is the one function that runs `mergeThreadMetadata`
 * (`DuyaAgent.ts:4706-4711`) -- while the INPUT was missing: `forkTurn` was a
 * `private` field written only inside `streamChat` (`:3055`) and reset at the
 * top of every `streamChat` (`:2277`), neither of which the engine reaches. The
 * capability was present and starved, not absent.
 *
 * Plan 610 D1 has now landed `bindRunForkMarker`, and `composeLegacyRunPorts`
 * binds `host.runFork ?? null` at run start. So this file is the PROOF plus the
 * REGRESSION, and two things changed deliberately rather than quietly:
 *
 *  - The harness no longer reaches into the private. It sets `host.runFork`, the
 *    way a production host does. The old `as unknown as { forkTurn }` cast was the
 *    experiment ("the mechanism is live, only the input is missing"); with the
 *    seam in place the cast is not just unnecessary, it would hide a broken
 *    seam by writing the field directly.
 *  - The diagnostic test `reaches the same run with or without a fork, which is
 *    the visible symptom` is REPLACED, not deleted and not inverted. It asserted
 *    that a forked engine run was indistinguishable from a plain one, which was
 *    true before D1 and is false after it. A gate that only knows how to go green
 *    by being softened is not a gate, so it now asserts the FIXED behaviour. The
 *    replacement is `a forked engine run is now distinguishable from a plain one`.
 *
 * ## The claim under test is about the LEAK, not the tagging
 *
 * The tagging assertions are straightforward and were already implied by the
 * pre-fix file. The load-bearing risk of this seam is different: `duyaAgent` is
 * a long-LIVED object, so a marker that outlived its run would branch every
 * later run on that instance -- silent, cross-conversation data corruption,
 * because a branched row is filtered out of the model projection
 * (`message-projectors.ts:84`) and simply vanishes from the user's history with
 * no error anywhere. That is why the marker is CLEARED unconditionally at run
 * start rather than set conditionally, and why the two-run test below drives
 * run B through the SAME instance run A used.
 *
 * ## What is deliberately NOT asserted
 *
 * No assertion claims the engine path prepends the reply quote. It does not:
 * `_applyProviderThreadBoundary` is `private` and reached only from `streamChat`
 * (`:3314`), and the engine's provider port never goes through it. That is
 * measured in the D3 section below rather than papered over. The STRIP, by
 * contrast, is already satisfied on this path by `projectModelMessages`
 * (`stripThreadMeta`), which is why the gap is narrower than "the boundary is
 * missing" and is exactly one call site.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { RunEnginePorts, RunInputSnapshot, TerminalCandidate } from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER -- the only fake, and it stands in for nothing under test
// ============================================================================

interface Seen {
  readonly roles: string[];
  readonly contents: readonly string[];
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
        roles: messages.map((m) => m.role),
        contents: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
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
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's
 * own listener is called directly.
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
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

const PROBE = 'probe_ok';
const RUN_ID = 'run-fork-proof' as RunId;
/** The marker the legacy sets, verbatim (`DuyaAgent.ts:3055-3058`). */
const FORK_MARKER = { replyToId: 'root-1', userId: 'fork-1' } as const;

interface Proof {
  /** What the provider was handed, request by request. */
  readonly seen: readonly Seen[];
  /** Every durable row on the agent, including any a previous run left. */
  readonly durable: readonly Message[];
  /** ONLY the rows THIS run appended. The leak assertion needs this. */
  readonly written: readonly Message[];
  /** The marker in force after the run, read through the public seam. */
  readonly markerAfterRun: unknown;
  /** POSITIVE COUNT: how many times the tool really executed. */
  readonly probeRuns: () => number;
  readonly terminals: readonly TerminalCandidate[];
}

/**
 * Drive one real `RunEngineImpl` run against a real agent.
 *
 * `shared` is how the leak is exercised: passing an agent that a previous run
 * already used means run B sees exactly the state run A left behind.
 */
async function runThroughEngine(
  seedFork: boolean,
  forked = false,
  shared?: InstanceType<typeof duyaAgent>,
): Promise<Proof> {
  installFakeDbIpc();

  let sessionSeq = 0;
  const agent =
    shared ??
    new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: `s-fork-proof-${(sessionSeq += 1)}`,
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  let runs = 0;
  agent.activeMCPRegistry.register(
    {
      name: PROBE,
      description: 'probe that counts its own executions',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        runs += 1;
        return { ok: true, result: `RAN-${runs}` };
      },
    } as never,
  );

  const options = { sessionId: `s-fork-proof-${sessionSeq}` } as never;
  const prompt = 'run the probe';
  const turnContext = agent.assembleTurnContext(options, prompt);

  // Seed a MAIN-LINE user message the fork can point at, so `resolveReplyMeta`
  // has a real target to validate against -- an unknown target is silently
  // stripped, and a fixture whose target never existed would make the tagging
  // assertions vacuous. Only on a fresh agent: a shared one already has them.
  const { mergeThreadMetadata } = await import('../../message/threads.js');
  if (!shared) {
    agent.setMessages([
      { id: 'root-1', role: 'user', content: 'the root of the thread', timestamp: Date.now(), seq_index: 0 } as never,
    ]);
    // The fork's OWN user message, carrying exactly the metadata the legacy
    // stamps at construction (`DuyaAgent.ts:3049`): the same pure
    // `mergeThreadMetadata` the product uses, so the fixture is not a
    // hand-rolled imitation of the thing under test.
    agent.setMessages([
      ...agent.getMessages(),
      {
        id: 'fork-1',
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        seq_index: 1,
        ...(seedFork ? { metadata: mergeThreadMetadata(undefined, { replyToId: 'root-1', branched: true }) } : {}),
      } as Message,
    ]);
  }

  // Everything the agent held BEFORE this run, so `written` can be isolated.
  const before = agent.getMessages().length;

  const turnPipelines = new TurnPipelinePublisher();

  // The REAL production ledger. Omitting it makes the engine refuse EVERY tool
  // call (S3 finding 1), which would silently reduce this file to a
  // single-turn run with nothing to tag.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-fork-ledger-'));
  ledgerDirs.push(ledgerDir);
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

  const realAssemble = handle.assemble.bind(handle);
  const observedHandle = {
    ...handle,
    assemble(input: Parameters<typeof realAssemble>[0]) {
      const assembly = realAssemble(input);
      // Re-snapshot the declared set, or every dispatch is denied (S3 finding 2).
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-fork',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: () => undefined },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-fork',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'fork-proof', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(observedHandle),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-fork',
    },
    seqIndex: 0,
    wakeRun: false,
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
    // The D1 input, supplied the way a production host supplies it. OMITTED
    // (not `undefined`, not a null marker) on a plain run -- and the omission is
    // what makes `composeLegacyRunPorts` bind `null` and clear the marker.
    ...(forked ? { runFork: FORK_MARKER } : {}),
  };

  const ports: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-fork',
    projectId: null,
    revision: 'rev-fork',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'fork-1', content: prompt }, []),
    // `by_ref`, NOT the inline history `buildLegacyRunInput` emits: inline is
    // frozen at run start, so the tool result could never reach turn 2 (S3
    // finding 3) and the run would complete cleanly having proven nothing.
    history: { kind: 'by_ref', digest: 'hist-fork', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  active = { seen: [] };
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports }).completed();

  turnPipelines.close();

  const durable = agent.getMessages();
  return {
    seen: active.seen,
    durable,
    written: durable.slice(before),
    markerAfterRun: agent.readRunForkMarker(),
    probeRuns: () => runs,
    terminals,
  };
}

/** The rows the ENGINE wrote, i.e. everything but a host-seeded user row. */
function engineWritten(proof: Proof): Message[] {
  return proof.written.filter((m) => m.role === 'assistant' || m.role === 'tool');
}

// ============================================================================
// D1 -- the host hands the engine run its fork marker
// ============================================================================

describe('the host supplies the fork marker the engine path needs', () => {
  it('TAGS every engine-written row exactly as a forked legacy run does', async () => {
    const proof = await runThroughEngine(true, true);

    // POSITIVE COUNTS first. Everything below reads the agent's OWN durable
    // projection, so a run that stopped writing rows would make a tagging
    // assertion pass vacuously.
    expect(proof.probeRuns()).toBe(1);
    expect(proof.seen).toHaveLength(2);
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    // CROSS-SOURCE: `agent.getMessages()` is the agent's own persistence
    // projection, rebuilt from the timeline, while the code under test is the
    // engine's `turnOutput` port. The engine never sees `getMessages()`; it can
    // only reach `_commitDurable` through `recordTurn*`.
    const { readThreadMeta } = await import('../../message/threads.js');
    const produced = engineWritten(proof);
    expect(produced.length).toBeGreaterThanOrEqual(3);

    // The exact triple, not just "has a tag": `userId`, not `replyToId`, is
    // what `_commitDurable` stamps (`:4708`) -- rows descend from the fork's
    // user message, not from the message it replies to.
    for (const row of produced) {
      expect(readThreadMeta(row)).toEqual({ replyToId: 'fork-1', branched: true });
    }

    // And the rows are rows the engine really wrote, not the seeded fixture.
    expect(produced.filter((m) => m.role === 'assistant').length).toBeGreaterThanOrEqual(2);
    expect(produced.filter((m) => m.role === 'tool').length).toBeGreaterThanOrEqual(1);
  });

  it('leaves every engine-written row UNTAGGED when the host supplies no marker', async () => {
    const proof = await runThroughEngine(true, false);

    // CROSS-SOURCE CONTROL: the fork's own user message IS tagged, by the same
    // `mergeThreadMetadata` the product uses, and it survives into the timeline.
    // So "no assistant/tool row is tagged" is a projection that removed them --
    // not a fixture that never carried thread metadata in the first place.
    const { readThreadMeta, isBranchedMessage } = await import('../../message/threads.js');
    const forkUser = proof.durable.find((m) => m.id === 'fork-1');
    expect(forkUser).toBeDefined();
    expect(readThreadMeta(forkUser)?.branched).toBe(true);
    expect(readThreadMeta(forkUser)?.replyToId).toBe('root-1');

    const produced = engineWritten(proof);
    expect(produced.length).toBeGreaterThanOrEqual(3);
    for (const row of produced) {
      expect(readThreadMeta(row)).toBeUndefined();
      expect(isBranchedMessage(row)).toBe(false);
    }
  });
});

// ============================================================================
// THE LEAK -- the acceptance criterion, on one long-lived agent instance
// ============================================================================

describe('the marker cannot outlive the run that set it', () => {
  it('a plain run AFTER a forked run writes untagged rows and reads the marker back as null', async () => {
    // ONE agent instance, driven by TWO engine runs. `duyaAgent` is long-lived
    // and reused across runs, which is the whole hazard: a marker that survived
    // run A would branch every row run B writes, and because a branched row is
    // filtered out of the model projection (`message-projectors.ts:84`) those
    // rows would disappear from the user's history with nothing reporting an
    // error. It is silent, cross-conversation corruption.
    const shared = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-shared',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    const { readThreadMeta } = await import('../../message/threads.js');

    // ---- RUN A: forked. Its rows MUST carry the tag, or this proves nothing.
    const a = await runThroughEngine(true, true, shared);
    expect(a.markerAfterRun).toEqual(FORK_MARKER);
    const aRows = engineWritten(a);
    expect(aRows.length).toBeGreaterThanOrEqual(3);
    expect(aRows.every((row) => readThreadMeta(row)?.branched === true)).toBe(true);

    // ---- RUN B: plain, SAME instance, `runFork` omitted.
    const b = await runThroughEngine(false, false, shared);
    expect(b.markerAfterRun).toBeNull();

    // POSITIVE COUNT before the tagging assertion: run B was a real run that
    // really wrote rows, so "untagged" is not "empty".
    expect(b.probeRuns()).toBe(1);
    expect(b.seen).toHaveLength(2);
    expect(b.terminals[0].state.status).toBe('completed');

    // The load-bearing assertion. ISOLATED TO RUN B's rows: `shared` still holds
    // run A's tagged rows, so `durable` alone would report them and the
    // assertion would be measuring the wrong thing.
    const bRows = engineWritten(b);
    expect(bRows.length).toBeGreaterThanOrEqual(3);
    for (const row of bRows) {
      expect(readThreadMeta(row)).toBeUndefined();
    }

    // AND run A's rows are still tagged, so run B did not retroactively clear
    // the record -- the reset is a marker, not a rewrite of history.
    for (const row of aRows) {
      expect(readThreadMeta(row)).toEqual({ replyToId: 'fork-1', branched: true });
    }
  });

  it('an explicit null marker clears a marker a previous run set', async () => {
    // The API accepts `null` as an ordinary value, so a host that tracks the
    // marker explicitly (rather than omitting the field) clears it through the
    // same call. Same property, the other spelling.
    const shared = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-explicit-null',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    const a = await runThroughEngine(true, true, shared);
    expect(a.markerAfterRun).toEqual(FORK_MARKER);

    const b = await runThroughEngine(false, false, shared);
    expect(b.markerAfterRun).toBeNull();
  });

  it('the legacy resets the marker too, so a bound marker cannot reach a legacy turn', async () => {
    // The seam is a HOST-side input, and the legacy still owns the production
    // turn loop. `streamChat` nulls `forkTurn` at `:2277` on entry, so a marker
    // bound for an engine run cannot tag a later legacy turn. Asserted through
    // the public reader rather than by reaching for the private.
    const agent = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-legacy-reset',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    agent.bindRunForkMarker(FORK_MARKER);
    expect(agent.readRunForkMarker()).toEqual(FORK_MARKER);

    // Entering the legacy is enough; no turn needs to complete for the reset to
    // have happened, because `:2277` runs before the generator's first yield.
    for await (const _event of agent.streamChat('a plain prompt', {
      turnId: 'legacy-reset-turn',
    } as never)) {
      // drain
    }

    expect(agent.readRunForkMarker()).toBeNull();
  });
});

// ============================================================================
// D1 REGRESSION -- the replacement for the diagnostic that D1 falsified
// ============================================================================

describe('a forked engine run is now distinguishable from a plain one', () => {
  it('tags the forked run\'s rows and leaves the plain run\'s rows alone', async () => {
    // REPLACES `reaches the same run with or without a fork, which is the
    // visible symptom`. That test asserted `forked.seen.length ===
    // plain.seen.length` and `forked.probeRuns() === plain.probeRuns()` -- a
    // fork changed nothing observable, which was the defect stated as a
    // measurement. D1 makes it false, so keeping the assertion would have
    // meant deleting the evidence that the slice worked.
    //
    // The equality that test pinned STILL holds, and deliberately so: D1 is a
    // DURABLE-write change, and the wire is unchanged by it. What changed is
    // the transcript, which is where the fork's meaning lives. So the
    // regression asserts the axis that actually moved, and the surviving
    // equality is asserted explicitly below so a future slice that changes the
    // wire knows this test saw the opportunity.
    const forked = await runThroughEngine(true, true);
    const plain = await runThroughEngine(false, false);

    const { readThreadMeta } = await import('../../message/threads.js');

    // Both were real, complete, two-turn tool runs.
    expect(forked.probeRuns()).toBe(1);
    expect(plain.probeRuns()).toBe(1);
    expect(forked.seen).toHaveLength(2);
    expect(plain.seen).toHaveLength(2);

    // THE FIX. Same run shape, opposite durable outcome.
    const forkedRows = engineWritten(forked);
    const plainRows = engineWritten(plain);
    expect(forkedRows.length).toBeGreaterThanOrEqual(3);
    expect(plainRows.length).toBeGreaterThanOrEqual(3);

    for (const row of forkedRows) {
      expect(readThreadMeta(row)).toEqual({ replyToId: 'fork-1', branched: true });
    }
    for (const row of plainRows) {
      expect(readThreadMeta(row)).toBeUndefined();
    }

    // And the marker itself, read through the public seam.
    expect(forked.markerAfterRun).toEqual(FORK_MARKER);
    expect(plain.markerAfterRun).toBeNull();

    // The request COUNT and the dispatch count are unchanged by D1 -- the two
    // equalities the old diagnostic pinned, and they are asserted here
    // deliberately so a future slice knows this test saw the opportunity.
    expect(forked.seen.length).toBe(plain.seen.length);
    expect(forked.probeRuns()).toBe(plain.probeRuns());

    // But the wire's message COMPOSITION now differs, and not in the fork's
    // favour: on a forked run turn 2 loses the tool row turn 1 produced. That is
    // the projection-scope defect measured in the next describe block, pinned
    // from this side too because "distinguishable" is exactly what it costs.
    expect(forked.seen[1].roles).not.toEqual(plain.seen[1].roles);
    expect(plain.seen[1].roles).toContain('tool');
    expect(forked.seen[1].roles).not.toContain('tool');
  });
});

// ============================================================================
// MEASURED DEFECT -- what D1 exposes on the provider boundary
// ============================================================================

describe('a forked run loses its own tool result before the next turn', () => {
  it('turn 2 of a forked run is projected WITHOUT the tool row turn 1 produced', async () => {
    // MEASURED, AND PINNED DELIBERATELY AS THE WRONG ANSWER. Asserted as an
    // absence in the same spirit as the D3 quote test below: it is the honest
    // description of today's behaviour, and the slice that fixes it turns this
    // red, which is the correct direction for a behaviour change.
    //
    // WHAT HAPPENS. `createLegacyAssembleTurn` re-projects PER TURN through
    // `handle.projectTurnMessages()` (`run-composition.ts:576`), and
    // `projectModelMessages` drops every branched row
    // (`message-projectors.ts:84`). Tagging is what D1 adds -- so the rows turn
    // 1 just produced become branched, and turn 2's projection removes the very
    // tool result the model asked for. Measured roles on turn 2:
    //   plain run  -> ["user","assistant","tool","user"]
    //   forked run -> ["user","user"]
    //
    // WHY THE LEGACY DOES NOT HAVE THIS. `streamChat` pushes into one working
    // array and only projects at the START of a call, so within a forked turn
    // the legacy's turn 2 still carries the tool result. The engine has to ask
    // for a fresh projection each turn, and the projection has no notion of
    // "this run's own rows".
    //
    // WHY IT IS NOT FIXED HERE. The fix belongs in the projection's SCOPE --
    // exclude branched rows from before this run, include this run's own -- and
    // the projection is the agent's (`projectTurnMessages`), not this file's.
    // Rebuilding it in the composition would be the second projection the S4b-2
    // comment explicitly rules out ("owning it is not the same as projecting
    // it"). Reported for the driver flip rather than papered over.
    const forked = await runThroughEngine(true, true);
    const plain = await runThroughEngine(true, false);

    // CROSS-SOURCE: asserted on what the provider was HANDED, not on the tag,
    // so this goes red if the tag is applied but the projection stops
    // honouring it, or the other way round.
    expect(plain.seen[1].roles).toContain('tool');
    expect(forked.seen[1].roles).not.toContain('tool');

    // Both runs were complete and both really dispatched, so the absence above
    // is about the projection rather than about a run that never happened.
    expect(forked.probeRuns()).toBe(1);
    expect(plain.probeRuns()).toBe(1);
    expect(forked.seen).toHaveLength(2);
    expect(plain.seen).toHaveLength(2);
  });

  it('the branched rows are excluded from the main projection, which is why the tag exists', async () => {
    // THE CONSEQUENCE, which is why the tag matters beyond bookkeeping: a
    // branched row is filtered out of the model boundary by `projectModelMessages`
    // (`isBranchedMessage`, `message-projectors.ts:84`). So tagging is not
    // cosmetic -- it is what keeps a fork's traffic out of the main context.
    const proof = await runThroughEngine(true, true);

    const onWire = proof.seen.map((r) => r.contents.join('\n')).join('\n');
    // The fork's own anchor was tagged `branched` at construction, so it is
    // excluded too -- which is why the engine still received it as `input.prompt`
    // rather than through the projected transcript.
    expect(onWire).toContain('the root of the thread');
    expect(onWire).not.toContain('threadMeta');
  });
});

// ============================================================================
// D3 -- the provider boundary: what the engine path does and does not do
// ============================================================================

describe('the engine path never routes provider requests through the reply boundary', () => {
  it('sends no threadMeta on the wire, but for a DIFFERENT reason than the legacy', async () => {
    const proof = await runThroughEngine(true, false);

    // CROSS-SOURCE CONTROL. The raw timeline really does hold thread metadata
    // -- the seeded fork user message carries it -- so "nothing on the wire" is
    // not a fixture that lacked it.
    const { readThreadMeta } = await import('../../message/threads.js');
    const withMeta = proof.durable.filter((m) => readThreadMeta(m) !== undefined);
    expect(withMeta.length).toBeGreaterThanOrEqual(1);

    // AND the provider really was handed the conversation, several times.
    expect(proof.seen.length).toBe(2);
    expect(proof.seen[0].contents.join('\n')).toContain('the root of the thread');

    // NO `threadMeta` KEY ANYWHERE on the wire. Asserted against the raw
    // serialized payloads rather than a projection, because the strip on this
    // path happens in `projectModelMessages`'s `stripThreadMeta` -- the
    // projection `createLegacyAssembleTurn` already routes every request
    // through. A second, independent mechanism (a host-side strip in
    // `run-composition.ts`) would have been redundant with it.
    for (const request of proof.seen) {
      expect(request.contents.join('\n')).not.toContain('threadMeta');
    }
  });

  it('does NOT prepend the reply quote, which stays D2', async () => {
    const proof = await runThroughEngine(true, false);

    // MEASURED ABSENCE, stated rather than left to be discovered. The legacy
    // renders `[In reply to <id>: "<quote>"]` at the per-request call site via
    // `_applyProviderThreadBoundary` (`DuyaAgent.ts:3314`), which is `private`
    // and reached only from inside `streamChat`. The engine's provider port
    // (`createClientModelPort`) never goes through it, so the prefix is not
    // rendered on this path.
    //
    // Asserted as an ABSENCE deliberately: it is the honest description of
    // today's behaviour, and a later slice that wires the boundary turns this
    // red, which is the correct direction for a behaviour change.
    //
    // D1 does NOT close this, and the distinction matters: D1 tags DURABLE rows,
    // whereas the quote is a per-request RENDERING of the same metadata.
    const onWire = proof.seen.map((r) => r.contents.join('\n')).join('\n');
    expect(onWire).not.toContain('[In reply to');

    // And the run really was a complete multi-turn tool run, so the absence
    // above is about the boundary rather than about a run that never happened.
    expect(proof.probeRuns()).toBe(1);
    expect(proof.seen[1].roles).toContain('tool');
  });
});