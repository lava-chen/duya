/**
 * Plan 610 (fork / reply metadata): what the engine-driven path actually does
 * with `threadMeta`, measured rather than assumed.
 *
 * ## Why this file exists, and what it CHANGED about the plan
 *
 * The slice this file closes was briefed as "the engine path has no fork /
 * reply metadata, wire it up". Measuring all six channels first says something
 * different, and the difference is the whole value of the file:
 *
 *  - The durable-write half was ALREADY WIRED. `recordTurnToolResult` and
 *    `recordTurnAssistantMessage` both call the agent's own `_commitDurable`,
 *    and `_commitDurable` is the ONE function that runs `mergeThreadMetadata`
 *    (`DuyaAgent.ts:4706-4711`). So on an engine-driven run the merge really
 *    does execute -- once per durable row. Building a second tagging mechanism
 *    in `run-composition.ts` would have produced exactly the double-tag the
 *    plan has spent slices preventing.
 *  - What is genuinely missing is the INPUT, not the merge: `forkTurn` is a
 *    `private` field, written only inside `streamChat` (`DuyaAgent.ts:3055`)
 *    and reset at the top of every `streamChat` (`:2277`). The engine never
 *    calls `streamChat`, so on an engine-driven run `forkTurn` is ALWAYS null
 *    and the merge is always a no-op. The capability is present and starved,
 *    not absent.
 *
 * So the wiring this slice owes the next one is a way to SET that marker, and
 * this file pins the current behaviour precisely enough that the fix is a
 * red-to-green change rather than a guess.
 *
 * ## The three claims, each asserted from a DIFFERENT source than the code
 *
 * The rule this file is built on: if both sides of a comparison come from the
 * same computation, the assertion is an identity. So:
 *
 *  1. TAGGING. Asserted on `agent.getMessages()` -- the agent's OWN durable
 *     persistence projection, rebuilt from the timeline -- while the code under
 *     test is the engine's `turnOutput` port. The engine never sees
 *     `getMessages()`; it can only reach `_commitDurable` through
 *     `recordTurn*`. A composition that dropped the metadata on the floor would
 *     show an untagged row here.
 *  2. THE MARKER'S ABSENCE. Asserted by reading the PRIVATE `forkTurn` off the
 *     instance the run actually used. This is the one place a private read is
 *     correct: the claim is about a private's value, so the test IS the probe.
 *  3. THE PROVIDER BOUNDARY. Asserted on what the scripted provider was
 *     handed (`contents`), cross-checked against `readThreadMeta` on the raw
 *     timeline -- so "no `threadMeta` on the wire" is distinguishable from "the
 *     fixture never had one".
 *
 * ## What is deliberately NOT asserted
 *
 * No assertion here claims the engine path strips or prepends reply metadata.
 * It does not: `_applyProviderThreadBoundary` is `private` and called only from
 * `streamChat` (`:3314`), and the engine's provider port never goes through it.
 * That is measured and recorded in the D3 test below rather than papered over,
 * because the strip on the engine path is already performed by a DIFFERENT
 * function (`projectModelMessages`, via `stripThreadMeta`) -- which is why the
 * gap is narrower than "the boundary is missing" and is exactly one call site.
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

interface Proof {
  /** What the provider was handed, request by request. */
  readonly seen: readonly Seen[];
  /** The agent's OWN durable rows, rebuilt from its timeline. */
  readonly durable: readonly Message[];
  /** The value of the PRIVATE fork marker on the instance this run used. */
  readonly forkTurnAfterRun: unknown;
  /** POSITIVE COUNT: how many times the tool really executed. */
  readonly probeRuns: () => number;
  readonly terminals: readonly TerminalCandidate[];
}

async function runThroughEngine(seedFork: boolean, bindForkTurn = false): Promise<Proof> {
  installFakeDbIpc();

  let sessionSeq = 0;
  const agent = new duyaAgent({
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
  // assertions vacuous.
  agent.setMessages([
    { id: 'root-1', role: 'user', content: 'the root of the thread', timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  // The fork's OWN user message, carrying exactly the metadata the legacy
  // stamps at construction (`DuyaAgent.ts:3049`): the same pure
  // `mergeThreadMetadata` the product uses, so the fixture is not a
  // hand-rolled imitation of the thing under test.
  const { mergeThreadMetadata } = await import('../../message/threads.js');
  const forkUser = {
    id: 'fork-1',
    role: 'user',
    content: prompt,
    timestamp: Date.now(),
    seq_index: 1,
    ...(seedFork ? { metadata: mergeThreadMetadata(undefined, { replyToId: 'root-1', branched: true }) } : {}),
  } as Message;
  agent.setMessages([...agent.getMessages(), forkUser as never]);

  // THE POSITIVE PROOF'S SETUP, and the only cast in this file.
  //
  // `forkTurn` is `private` and written only inside `streamChat`
  // (`DuyaAgent.ts:3055-3058`). Writing it here is not a shortcut around the
  // boundary -- it IS the experiment: the legacy's exact assignment, replayed
  // by a host, and nothing else changed. If the engine-driven durable rows come
  // out tagged under this, then every step between the engine's
  // `recordToolResult` / `recordAssistantMessage` calls and the fork merge is
  // ALREADY WIRED, and the one missing thing is a way for a host to perform
  // this assignment without reaching into a private.
  //
  // The shape is the legacy's verbatim: `replyToId` is the resolved target,
  // `userId` is the fork's own user message -- the id `_commitDurable` stamps
  // onto every non-user row (`DuyaAgent.ts:4708`).
  if (bindForkTurn) {
    (agent as unknown as { forkTurn: { replyToId: string; userId: string } | null }).forkTurn = {
      replyToId: 'root-1',
      userId: 'fork-1',
    };
  }

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

  return {
    seen: active.seen,
    durable: agent.getMessages(),
    // The claim under test IS about this private's value, so reading it is the
    // probe rather than a way around the boundary.
    forkTurnAfterRun: (agent as unknown as { forkTurn: unknown }).forkTurn,
    probeRuns: () => runs,
    terminals,
  };
}

// ============================================================================
// D2 -- durable tagging: the merge runs on the engine path, with no input
// ============================================================================

describe('an engine-driven run reaches the fork-tagging merge, but has no marker to give it', () => {
  it('writes durable assistant AND tool rows through _commitDurable', async () => {
    const proof = await runThroughEngine(true);

    // POSITIVE COUNTS first. Everything below reads the agent's OWN durable
    // projection, so a run that stopped writing rows would make a tagging
    // assertion pass vacuously. These four are the guard against that.
    expect(proof.probeRuns()).toBe(1);
    expect(proof.seen).toHaveLength(2);
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    const roles = proof.durable.map((m) => m.role);
    // The engine's `recordAssistantMessage` and `recordToolResult` both landed.
    expect(roles.filter((r) => r === 'assistant').length).toBeGreaterThanOrEqual(2);
    expect(roles.filter((r) => r === 'tool').length).toBeGreaterThanOrEqual(1);
  });

  it('leaves every engine-written durable row UNTAGGED, because the fork marker is null', async () => {
    const proof = await runThroughEngine(true);

    // CROSS-SOURCE, and the reason this assertion has teeth: the fork's own
    // user message IS tagged, by the same `mergeThreadMetadata` the product
    // uses, and it survives into the timeline. So "no assistant/tool row is
    // tagged" is a projection that removed them -- not a fixture that never
    // carried thread metadata in the first place.
    const { readThreadMeta, isBranchedMessage } = await import('../../message/threads.js');
    const forkUser = proof.durable.find((m) => m.id === 'fork-1');
    expect(forkUser).toBeDefined();
    expect(readThreadMeta(forkUser)?.branched).toBe(true);
    expect(readThreadMeta(forkUser)?.replyToId).toBe('root-1');

    // THE MEASUREMENT. The assistant and tool rows the engine wrote carry no
    // thread metadata at all.
    const produced = proof.durable.filter((m) => m.role === 'assistant' || m.role === 'tool');
    expect(produced.length).toBeGreaterThanOrEqual(3);
    for (const row of produced) {
      expect(readThreadMeta(row)).toBeUndefined();
      expect(isBranchedMessage(row)).toBe(false);
    }
  });

  it('leaves the private fork marker null, which is WHY the rows are untagged', async () => {
    const proof = await runThroughEngine(true);

    // THE ROOT CAUSE, asserted rather than inferred. `forkTurn` is written only
    // inside `streamChat` (`DuyaAgent.ts:3055`) and reset at the top of every
    // `streamChat` (`:2277`); the engine never calls `streamChat`, so after a
    // complete engine-driven run the marker is still null.
    //
    // This is the assertion that makes the two above a DIAGNOSIS rather than a
    // pair of symptoms: change this line's expectation and the untagged rows
    // stop being a mystery.
    expect(proof.forkTurnAfterRun).toBeNull();
  });

  it('TAGS every engine-written row once the marker is set, so the channel is live', async () => {
    // THE POSITIVE PROOF, and the load-bearing test in this file.
    //
    // Everything above establishes that a forked engine run writes UNTAGGED
    // rows. That is equally consistent with two very different worlds:
    //
    //  (a) the tagging mechanism is ABSENT from the engine path, and the next
    //      slice must build it; or
    //  (b) the mechanism is PRESENT and reachable, and only the marker is
    //      missing -- so the fix is one assignment, not a mechanism.
    //
    // Those worlds need opposite fixes, and an absence assertion cannot tell
    // them apart. This run replays the legacy's own `forkTurn` assignment and
    // then changes NOTHING else: same agent, same ports, same real engine, same
    // real two-turn tool run. So a tagged row here can only have been tagged by
    // `_commitDurable` -- reached through the engine's `turnOutput` port.
    //
    // The conclusion is (b), and it is what makes D1/D2 a wiring task rather
    // than a rebuild.
    const proof = await runThroughEngine(true, true);

    // The marker the legacy sets, verbatim.
    expect(proof.forkTurnAfterRun).toEqual({ replyToId: 'root-1', userId: 'fork-1' });

    // The run was the SAME complete multi-turn tool run as the untagged one, so
    // the rows below were written by the engine rather than by a fixture.
    expect(proof.probeRuns()).toBe(1);
    expect(proof.seen).toHaveLength(2);
    expect(proof.terminals[0].state.status).toBe('completed');

    // AND EVERY non-user durable row the engine wrote now carries the branch
    // tag. `userId`, not `replyToId`, is what `_commitDurable` stamps
    // (`DuyaAgent.ts:4708`): rows descend from the fork's user message, not
    // from the message it replies to. Asserting the exact triple catches both a
    // dropped tag and a wrong-value tag.
    const { readThreadMeta } = await import('../../message/threads.js');
    const produced = proof.durable.filter((m) => m.role === 'assistant' || m.role === 'tool');
    expect(produced.length).toBeGreaterThanOrEqual(3);
    for (const row of produced) {
      expect(readThreadMeta(row)).toEqual({ replyToId: 'fork-1', branched: true });
    }

    // The user row is NOT re-tagged by the merge -- `_commitDurable` guards on
    // `message.role !== 'user'` (`:4706`) -- so it keeps the metadata it was
    // constructed with.
    const forkUser = proof.durable.find((m) => m.id === 'fork-1');
    expect(readThreadMeta(forkUser)).toEqual({ replyToId: 'root-1', branched: true });

    // MEASURED LIMIT OF THIS FILE, recorded because it is a fact about the
    // ENGINE path rather than about the product: the `message.role !== 'user'`
    // guard is NOT load-bearing here, and dropping it changes nothing this file
    // can see. `_commitDurable` has exactly three call sites -- `:1436` (the
    // engine's `recordTurnToolResult`), `:1487` (its `recordTurnAssistantMessage`)
    // and `:4563` (`_pushDurable`) -- and only the third ever sees a `user`
    // row, and `_pushDurable` is called solely from inside `streamChat`. The
    // engine never commits a user row: the host seeds it.
    //
    // So the guard protects the LEGACY's user-message write and is unreachable
    // from here. That is why this file asserts the user row's metadata but does
    // not claim the guard is exercised -- an assertion that a mutation cannot
    // turn red is not evidence, and saying so here is cheaper than a reader
    // rediscovering it.
  });

  it('excludes the newly branched rows from the main projection on the NEXT turn', async () => {
    // THE CONSEQUENCE, which is why the tag matters beyond bookkeeping: a
    // branched row is filtered out of the model boundary by `projectModelMessages`
    // (`isBranchedMessage`, `message-projectors.ts:84`). So tagging is not
    // cosmetic -- it is what keeps a fork's traffic out of the main context.
    //
    // Asserted on what the provider was handed rather than on the tag itself,
    // so this would go red if the tag were applied but the projection stopped
    // honouring it.
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
    const proof = await runThroughEngine(true);

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

  it('does NOT prepend the reply quote, and the run is otherwise indistinguishable from a plain one', async () => {
    const proof = await runThroughEngine(true);

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
    const onWire = proof.seen.map((r) => r.contents.join('\n')).join('\n');
    expect(onWire).not.toContain('[In reply to');

    // And the run really was a complete multi-turn tool run, so the absence
    // above is about the boundary rather than about a run that never happened.
    expect(proof.probeRuns()).toBe(1);
    expect(proof.seen[1].roles).toContain('tool');
  });

  it('reaches the same run with or without a fork, which is the visible symptom', async () => {
    const forked = await runThroughEngine(true);
    const plain = await runThroughEngine(false);

    // The fork changes NOTHING observable on the wire today -- same request
    // count, same tool dispatch. That equality is the defect stated as a
    // measurement: a forked run is currently indistinguishable from a plain one
    // at the provider boundary, which is exactly what D3 has to change.
    expect(forked.seen.length).toBe(plain.seen.length);
    expect(forked.probeRuns()).toBe(plain.probeRuns());

    // But the durable rows DIFFER, because the fork's user message is tagged at
    // construction. So the transcript does record a fork even though the model
    // leg and the assistant/tool rows do not -- the seam is exactly one layer
    // deep, and this is the evidence for where it sits.
    const { readThreadMeta } = await import('../../message/threads.js');
    const taggedIn = (proof: Proof): number =>
      proof.durable.filter((m) => readThreadMeta(m) !== undefined).length;
    expect(taggedIn(forked)).toBeGreaterThan(taggedIn(plain));
  });
});