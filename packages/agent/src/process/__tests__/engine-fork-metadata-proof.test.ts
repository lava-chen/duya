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
 *
 * `marker` exists so a SECOND fork off the same root can be driven with a
 * different `userId`. Scoping by the branch root instead of the fork's own user
 * row would hand each fork the other's rows, and no other fixture here can see
 * that: every other test runs at most one fork per agent.
 *
 * `probeLabel` exists because the probe's counter is per RUN, so two runs on
 * one agent both answer `RAN-1` and their tool results are indistinguishable in
 * a wire payload. The probe's return value is the cross-source witness for
 * "this run's row reached this run's wire", so a test that compares two runs has
 * to be able to tell whose answer it is looking at.
 */
async function runThroughEngine(
  seedFork: boolean,
  forked = false,
  shared?: InstanceType<typeof duyaAgent>,
  marker: { readonly replyToId: string; readonly userId: string } = FORK_MARKER,
  probeLabel = 'RAN',
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
        return { ok: true, result: `${probeLabel}-${runs}` };
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
    assembleTurn: createLegacyAssembleTurn(handle),
    // The handle owns the guard; the host names it and the model leg calls it
    // per attempt (plan 610 P3). Omitting it left the guard EMPTY.
    refreshDeclaredTools: () => handle.refreshDeclaredTools(),
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
    ...(forked ? { runFork: marker } : {}),
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
    // This fixture's own locator and digest over the builder's `by_ref` shape.
    // Before plan 610 P2 the builder emitted an INLINE history, which is frozen
    // at run start: the tool result could never reach turn 2 (S3 finding 3) and
    // the run completed cleanly having proven nothing.
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

/**
 * A durable row's content as text, whatever shape it carries. A tool row's
 * content is a block array, so `String(row.content)` would read `[object
 * Object]` and assert nothing.
 */
function rowText(row: Message): string {
  return typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
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
    const plain = await runThroughEngine(true, false);

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

    // And the wire's message COMPOSITION now matches a plain run's on turn 2.
    //
    // This line USED to read `not.toEqual(plain.seen[1].roles)` plus two
    // absences, pinning the projection-scope defect from this side ("a fork is
    // distinguishable because it is worse off"). Plan 610's scope fixed it, so
    // the difference is gone: a fork now differs in the DURABLE transcript --
    // asserted above -- and not in what its own model is shown.
    //
    // Cross-run, not an identity: `forked` and `plain` are two independent runs,
    // so the two sides can genuinely disagree.
    //
    // The control is seeded IDENTICALLY (`seedFork: true` on both), and that is
    // load-bearing rather than tidy: the seeded fork row is branched, so it is
    // excluded from the plain run's projection and reaches it as the run's
    // `input.prompt` instead. An unseeded control would carry that same row
    // UNTAGGED, put it in the projection, and report one extra `user` turn that
    // has nothing to do with the fork.
    expect(forked.seen[1].roles).toEqual(plain.seen[1].roles);
  });
});

// ============================================================================
// THE PROJECTION SCOPE -- a forked run's own rows reach its own wire
// ============================================================================

describe('a forked run keeps its own rows on its own wire', () => {
  it('turn 2 of a forked run carries the assistant and tool rows turn 1 produced', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the change is the whole slice.
    // It read `expect(forked.seen[1].roles).not.toContain('tool')`, an absence
    // pinned deliberately so the defect had a name. It is rewritten, not
    // deleted and not inverted -- the absence described real behaviour and the
    // behaviour is now different.
    //
    // WHAT WAS WRONG. `createLegacyAssembleTurn` re-projects PER TURN through
    // `handle.projectTurnMessages()`, and `projectModelMessages` drops every
    // branched row. D1 made the tagging work, so the rows turn 1 produced became
    // branched, and turn 2's projection removed the very tool result the model
    // had asked for. Measured roles on turn 2, before the scope:
    //   plain run  -> ["user","assistant","tool","user"]
    //   forked run -> ["user","user"]
    //
    // WHY THE LEGACY NEVER SHOWED IT. `streamChat` pushes into one working
    // array and only projects at the START of a call, so within a forked turn
    // the legacy's turn 2 still carries the tool result. Measured on the
    // production path, a forked legacy run: ["user","user","assistant","tool"].
    //
    // WHY IT IS NOT A LEAK. The scope is `forkTurn.userId` -- the fork's OWN
    // user row, which is what `_commitDurable` stamps on the rows this run
    // writes. The main projection is untouched, so the same rows stay out of the
    // main line; the two tests below observe that rather than assert it.
    const forked = await runThroughEngine(true, true);
    const plain = await runThroughEngine(true, false);

    // CROSS-SOURCE, and deliberately not a helper: `RAN-1` is the PROBE'S OWN
    // return value, so it can only be on this wire if the tool really executed
    // AND the projection carried the row it produced. Nothing on the code under
    // test computes that string.
    expect(forked.probeRuns()).toBe(1);
    expect(forked.seen).toHaveLength(2);
    expect(forked.seen[1].roles).toContain('tool');
    expect(forked.seen[1].contents.join('\n')).toContain('RAN-1');

    // The assistant turn that ASKED for the tool is there too, and the two sit
    // in the order the timeline gives them -- a tool result restored to the end
    // of the request would satisfy the first assertion and still be wrong.
    expect(forked.seen[1].roles.indexOf('assistant')).toBeLessThan(
      forked.seen[1].roles.lastIndexOf('tool'),
    );

    // AND the composition is now the plain run's, row for row. Two independent
    // runs, so the two sides can disagree; the fork's cost is in the durable
    // transcript, not on its own wire.
    expect(forked.seen[1].roles).toEqual(plain.seen[1].roles);
  });

  it('the branched rows are excluded from the main projection, which is why the tag exists', async () => {
    // THE CONSEQUENCE, which is why the tag matters beyond bookkeeping: a
    // branched row is filtered out of the model boundary by `projectModelMessages`
    // (`isBranchedMessage`, `message-projectors.ts:84`). So tagging is not
    // cosmetic -- it is what keeps a fork's traffic out of the main context.
    //
    // UNCHANGED by the scope, and it is the guard for the half of the change
    // that must not happen: the rows are now RESTORED for the run that wrote
    // them, and still dropped for everyone else.
    const proof = await runThroughEngine(true, true);

    const onWire = proof.seen.map((r) => r.contents.join('\n')).join('\n');
    // The fork's own anchor was tagged `branched` at construction, so it is
    // excluded too -- which is why the engine still received it as `input.prompt`
    // rather than through the projected transcript.
    expect(onWire).toContain('the root of the thread');
    expect(onWire).not.toContain('threadMeta');
  });

  it('a LATER run on the same agent sees none of a finished fork\'s rows', async () => {
    // REQUIREMENT (2), BY OBSERVATION. The other test in this block asserts
    // what the forked run's own wire contains; this one asserts what a
    // DIFFERENT run's wire contains, which is the half that cannot be checked
    // from inside the fork.
    //
    // `A-1` / `B-1` are the probe's own return values and the label is per run,
    // so each string names exactly one run's tool execution. That is what makes
    // the absence checkable even though both runs replay the same script and
    // write near-identical assistant text.
    const shared = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-scope-leak',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    const a = await runThroughEngine(true, true, shared, FORK_MARKER, 'A');
    // POSITIVE COUNT first: the fork really wrote the rows that must not appear
    // later, so the absence below is not "the run wrote nothing".
    const aTool = engineWritten(a).find((row) => row.role === 'tool');
    expect(aTool).toBeDefined();
    expect(rowText(aTool as Message)).toContain('A-1');

    // Run B, same long-lived agent, and it is a PLAIN run -- the composition
    // binds no scope for it, so its projection is the main projection.
    const b = await runThroughEngine(false, false, shared, FORK_MARKER, 'B');
    expect(b.markerAfterRun).toBeNull();

    // Turn 1 is the purest observation available: it is projected before B has
    // written anything, so everything on that wire came out of the projection.
    for (const request of b.seen) {
      expect(request.contents.join('\n')).not.toContain('A-1');
    }

    // AND B was a complete two-turn tool run whose OWN result is on its wire --
    // so the absence is about the projection, not about a run that never
    // happened or a tool that never dispatched.
    expect(b.probeRuns()).toBe(1);
    expect(b.seen).toHaveLength(2);
    expect(b.seen[1].roles).toContain('tool');
    expect(b.seen[1].contents.join('\n')).toContain('B-1');
  });

  it('a SECOND fork off the same root does not inherit the first fork\'s rows', async () => {
    // The scope's discriminating power, which the run-above test cannot show:
    // both forks hang off `root-1`, so a scope keyed on the BRANCH ROOT would
    // satisfy every other test in this file and still hand fork B fork A's
    // exchange. `_commitDurable` stamps each run's rows with `forkTurn.userId`
    // precisely so the two are separable.
    const shared = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-two-forks',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    const a = await runThroughEngine(true, true, shared, { replyToId: 'root-1', userId: 'fork-A' }, 'A');
    const aTool = engineWritten(a).find((row) => row.role === 'tool');
    expect(aTool).toBeDefined();
    expect(rowText(aTool as Message)).toContain('A-1');

    // Same root, different fork user row.
    const b = await runThroughEngine(
      true,
      true,
      shared,
      { replyToId: 'root-1', userId: 'fork-B' },
      'B',
    );
    expect(b.markerAfterRun).toEqual({ replyToId: 'root-1', userId: 'fork-B' });

    // B sees its OWN tool result on turn 2, and neither fork's result leaks into
    // the other. Asserted per request rather than once over the joined wire, so
    // the turn-1 absence is stated separately from the turn-2 presence.
    expect(b.probeRuns()).toBe(1);
    expect(b.seen).toHaveLength(2);
    expect(b.seen[1].roles).toContain('tool');
    expect(b.seen[1].contents.join('\n')).toContain('B-1');
    for (const request of b.seen) {
      expect(request.contents.join('\n')).not.toContain('A-1');
    }
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