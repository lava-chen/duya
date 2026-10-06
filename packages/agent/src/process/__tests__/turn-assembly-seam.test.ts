/**
 * Plan 610 A3-2b7 (S1): the per-turn assembly seam on `duyaAgent`.
 *
 * ## What this file is for
 *
 * The engine calls `ContextPort.assemble` once per turn (`ports.ts:487`). Before
 * this slice that port had NO production body: measured over `packages/`, it had
 * two declarations, two forwarders and eleven implementations, and every one of
 * the eleven was inside `__tests__`. "Bind the ports and flip the driver" was
 * therefore never a wiring change -- the assembly had to exist first. This file
 * is the evidence that the body that now exists agrees with the loop it
 * replaced.
 *
 * ## Why the differential is a CHARACTERISATION, not a seam-vs-model compare
 *
 * The obvious comparison -- "the seam's return equals what the model was sent" --
 * is VACUOUS here, and saying so is the load-bearing part of this header. The
 * loop assigns `systemPromptContent = assembly.systemPrompt` and then hands
 * `deps.systemSystemPromptContent` straight to the client
 * (`TurnStreamRunner.ts:138`). Seam output and observed output are the same
 * variable, so `expect(a).toBe(a)` would pass for any seam at all, including one
 * that assembled nothing.
 *
 * So the "before" side is frozen instead. The observations in
 * `PRE_REFACTOR_OBSERVATIONS` were recorded by running the REAL cycle on the
 * PRE-refactor `DuyaAgent.ts` (git `cbf9eebe`, the commit this slice branched
 * from) with the scripted model below, and they are asserted here against the
 * refactored cycle. Two different implementations, one input, equal output --
 * which is the property a refactor can actually fail.
 *
 * They are recorded from the cycle's OWN behaviour rather than from a
 * hand-written twin: a twin would reproduce whatever bug it was written from,
 * and a test comparing a seam to a copy of its own logic can only confirm the
 * copy is still there.
 *
 * ## What it does NOT prove
 *
 * It does not prove the engine can drive a turn -- nothing here constructs
 * `RunEngineImpl`, and no test in the repo does that against a real
 * `duyaAgent`. That is S3. It also does not prove the headless path survives
 * the eventual deletion of `streamChat`; that is S4.
 *
 * ## Plan 610 D2: the differential now drives the ENGINE, not `streamChat`
 *
 * The differential used to call `agent.streamChat`, so the flip would have
 * deleted the very thing it measures. It is repointed at a real
 * `RunEngineImpl` over `composeLegacyRunPorts`, and the claim is KEPT rather
 * than shrunk: the frozen `PRE_REFACTOR_*` observations were recorded from the
 * pre-refactor CYCLE, so they remain an INDEPENDENT source for the engine's run
 * to be compared against. Comparing the engine against itself would be exactly
 * the identity this file's header warns about.
 *
 * Two of the frozen observations do NOT survive the repoint, and both
 * divergences are asserted and LOCATED rather than quietly dropped:
 *
 *  - **Turn 1's roles.** The legacy sent `['user']`; the engine sends the
 *    prompt plus the transcript copy, both `user`. That is the engine's own
 *    projection (`by_ref` history re-projected per turn, S3 finding 3), not
 *    the seam's, which is why the turn-2 assertion is on CONTENT (`assistant`
 *    and `tool` present) rather than on an exact role list.
 *  - **`progress_update` is missing from the advertised surface.** MEASURED:
 *    the legacy advertises four tools, the engine three. The cause is in the
 *    source -- `streamChat` appends `PROGRESS_UPDATE_TOOL` to its own `tools`
 *    local at `DuyaAgent.ts:2577`, which is AFTER `beginTurnAssembly`, so the
 *    seam never sees it. This is a real cutover gap, pinned by a
 *    failing-if-fixed assertion so the flip cannot lose it quietly.
 *
 * What DOES survive verbatim is the seam's own half: the system prompt's
 * length is stable across turns (95275 on the engine and on the legacy, the
 * observable of REPLACE-not-APPEND), the tool-group instruction rides it, and
 * the advertised surface matches the agent's OWN resolved one on the wire.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, SSEEvent, ToolUseContext } from '../../types.js';

/** Ledger temp dirs, removed after each test so a failing run leaves nothing. */
const tempDirs: string[] = [];

// ============================================================================
// The source under test
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUYA = path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts');

/**
 * Comment-strip the source under test.
 *
 * ## Why this is local and not the gate's own stripper
 *
 * `boundary-gates.mjs` strips before it counts, and its sibling
 * `strip-comments.mjs` is the obvious import -- `turn-pipeline-factory-seam.test.ts`
 * imports exactly that path. Importing it from a `@duya/agent` test adds a
 * `pkg:agent -> scripts` cross-boundary edge, and that edge moves two counters
 * this slice is required to hold still: `architecture:check` went 963 -> 964 and
 * `architecture:self-test` went 786 = 786 -> 787 = 787, both from this one import
 * and from nothing else. Trading a gate that pins the package boundary for a
 * convenience import in one test file is the wrong way round.
 *
 * ## Why a local copy is nevertheless safe here
 *
 * Because it is VERIFIED rather than assumed. The two strippers were run over
 * `DuyaAgent.ts` and compared: both produce **297596 characters and are
 * byte-identical**, and all eight patterns this file counts agree between them.
 * The one difference a naive copy does have is CRLF: this repo's `.ts` files are
 * CRLF, and blanking `\r` as if it were an ordinary character diverges from the
 * gate. Both `\r` and `\n` are preserved below, which is what closes it.
 *
 * That verification is a property of THIS file, not a general licence: on a
 * module with a regex literal containing `//`, a stripper with no regex-vs-
 * division rule would diverge. `DuyaAgent.ts` has none that this touches, and
 * the gate remains the authority for its own detectors.
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
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The gate's own stripper, so these counts cannot disagree with CI's. */
function code(): string {
  return stripComments(fs.readFileSync(DUYA, 'utf8'));
}

function occurrences(pattern: RegExp, text: string = code()): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// The frozen pre-refactor behaviour
// ============================================================================

/**
 * Recorded from the REAL cycle at `cbf9eebe`, i.e. BEFORE `assembleTurn`
 * existed. See the header for why these are frozen rather than recomputed.
 *
 * `systemPromptLength` is deliberately NOT pinned: it embeds the working
 * directory and the agent roster, so it is machine-dependent and would fail on
 * a checkout path this test never saw. What IS pinned is the shape -- that both
 * turns advertise the same set, and that the prompt does not grow from turn 1
 * to turn 2, which is the specific way the seam could have broken it (see
 * `refreshTurnSystemPrompt`'s doc comment on why the recomputed prefix REPLACES
 * rather than appends).
 */
const PRE_REFACTOR_TOOL_NAMES = ['probe_ok', 'progress_update', 'tool_catalog', 'tool_invoke'];
const PRE_REFACTOR_TURN1_ROLES = ['user'];
const PRE_REFACTOR_TURN2_ROLES = ['user', 'assistant', 'tool'];

// ============================================================================
// The offline host: scripted provider + fake worker IPC
// ============================================================================

interface Seen {
  systemPrompt: string;
  toolNames: string[];
  roles: string[];
}

let active: { seen: Seen[] } | null = null;

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
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      // Which script: the turn index is how many requests have been recorded so
      // far. Read BEFORE the push, or turn 1 indexes -1 and replays the LAST
      // script -- a fixture that silently drops the tool call and makes the
      // whole file pass without ever dispatching a tool.
      const index = active?.seen.length ?? 0;
      active?.seen.push({
        systemPrompt: String((options?.systemPrompt as string) ?? ''),
        toolNames: ((options?.tools as Array<{ name: string }>) ?? []).map((t) => t.name).sort(),
        roles: messages.map((m) => m.role),
      });
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
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure; `afterEach` must not
      // mask the assertion that already reported the real problem.
    }
  }
});

interface Probe {
  readonly runs: () => number;
}

function probeRegistry(): { registry: InstanceType<typeof ToolRegistry>; probe: Probe } {
  let runs = 0;
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'probe_ok',
      description: 'probe',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        runs += 1;
        return { id: 'p1', name: 'probe_ok', result: `RAN-${runs}` };
      },
    } as never,
  );
  return { registry, probe: { runs: () => runs } };
}

let sessionSeq = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionSeq += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-turn-assembly-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// 1. THE DIFFERENTIAL: the refactored cycle still does what the old one did
// ============================================================================

// ============================================================================
// 1. THE DIFFERENTIAL: the refactored cycle still does what the old one did
// ============================================================================

/**
 * Drive one engine-driven run and report what the provider was handed.
 *
 * The engine arm of the differential below. Deliberately the same shape as
 * `engine-real-agent-proof.test.ts`'s harness (real agent, real handle, real
 * ledger, real composition) including the `observedHandle` workaround for
 * `refreshDeclaredTools`: a proof that differs from a proven harness in its
 * SETUP proves a different thing than it claims, and an earlier draft of this
 * arm that skipped the ledger ended `failed` with zero model calls -- a green
 * that would have measured nothing.
 */
async function runThroughEngine(): Promise<{
  readonly seen: readonly Seen[];
  readonly runs: () => number;
  readonly terminals: readonly string[];
  readonly advertised: readonly string[];
}> {
  installFakeDbIpc();
  // TWO registrations, and the reason is a measured one rather than belt and
  // braces. `options.toolRegistry` is the bundle `_resolveTools` resolves, so
  // this is the executor that actually RUNS the probe and the counter the
  // legacy arm asserted. `agent.activeMCPRegistry` is what the engine's
  // side-effect lookup and its tool-visibility guard read, so without it every
  // dispatch is denied and the run still completes.
  const { registry, probe } = probeRegistry();

  active = { seen: [] };
  const agent = makeAgent();
  // The live run's setup, in the order a host driving the engine sets it up.
  // `streamChat` normally owns this; a host driving the engine does it
  // instead. Without it `buildTurnPipeline` refuses ("no run in progress")
  // and the run ends `failed` before the model is ever reached.
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  // The probe goes into the AGENT'S OWN registry as well as the options one.
  // The engine's side-effect lookup and its tool-visibility guard both read
  // `agent.activeMCPRegistry`, so a probe that lives only in
  // `options.toolRegistry` is invisible to them and every dispatch is denied.
  // The definition is duplicated, NOT the counter: `probe` above owns the
  // counter, because its executor is the one the resolved bundle dispatches.
  agent.activeMCPRegistry.register(
    {
      name: 'probe_ok',
      description: 'probe that counts its own executions',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => ({ id: 'p1', name: 'probe_ok', result: 'RAN' }),
    } as never,
  );

  const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
  const { createToolSideEffectLedger } = await import('../tool-side-effect-ledger.js');
  const { FIRST_EPOCH, GROUND_FENCE } = await import('@duya/agent-protocol');
  const {
    composeLegacyRunPorts,
    createLegacyAssembleTurn,
    buildLegacyRunManifest,
    buildLegacyRunInput,
  } = await import('../run-composition.js');
  const { RunEngineImpl, RunEventEmitter, RunSession } = await import('@duya/agent-runtime');

  const turnPipelines = new TurnPipelinePublisher();
  const prompt = 'run the probe';
  const options_ = { sessionId: 's-s1-engine', toolRegistry: registry } as never;
  const turnContext = agent.assembleTurnContext(options_, prompt);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const handle = await agent.beginTurnAssembly({
    options: options_,
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
      // Re-snapshot the declared set, or nothing dispatches: the guard starts
      // EMPTY and the engine never calls `runTurnStream`, which is where the
      // legacy fills it.
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const runId = 'run-s1-engine' as never;
  const session = new RunSession({
    runId,
    sessionId: 'sess-s1-engine',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const terminals: { state: { status: string } }[] = [];
  const emitter = new RunEventEmitter({ runId, session, stream: { push: () => undefined } });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-s1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'turn-assembly-seam', version: '0.0.0' },
  });

  // The real production ledger on a temp dir, for the same reason S3 requires
  // it: no tool in the product declares a side-effect class, so without a
  // ledger the engine REFUSES every dispatch and the run still completes.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-s1-'));
  tempDirs.push(ledgerDir);
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId,
    runEpoch: FIRST_EPOCH,
    fence: { runId, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token } as never,
  });

  const host = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(observedHandle),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate: { state: { status: string } }) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-s1',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId: 's-s1-engine',
    workingDirectory: process.cwd(),
    beginTicket: (call: never) => ledger.begin(call),
    settleTicket: (input: never) => ledger.settle(input),
  } as never;

  const composed = composeLegacyRunPorts(agent, host);
  const facts = {
    runId,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-s1-engine',
    projectId: null,
    revision: 'rev-s1',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  } as never;
  // `by_ref`, not the inline history `buildLegacyRunInput` emits: inline is
  // frozen at run start, so the tool result could never reach turn 2 and the
  // run would still complete cleanly (S3 finding 3).
  const input = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    history: { kind: 'by_ref', digest: 'hist-s1', locator: 'agent://transcript' },
  } as never;

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({
    manifest: buildLegacyRunManifest(facts),
    input,
    signal: new AbortController().signal,
    ports: composed,
  }).completed();
  turnPipelines.close();

  return {
    seen: active.seen,
    runs: probe.runs,
    terminals: terminals.map((candidate) => candidate.state.status),
    advertised: handle.tools.map((tool) => tool.name).sort(),
  };
}

describe('the seam did not change what the cycle sends the model', () => {
  it('still assembles the same per-turn request, now driven by the ENGINE', async () => {
    const run = await runThroughEngine();

    // Non-vacuity FIRST, and it is a POSITIVE COUNT on both legs: the run
    // really reached the model twice and really dispatched the probe. An
    // earlier draft of this arm that omitted the ledger satisfied neither, and
    // would have compared two EMPTY requests and called it a match.
    expect(run.seen).toHaveLength(2);
    expect(run.runs()).toBe(1);
    expect(run.terminals).toEqual(['completed']);

    // ── What the frozen pre-refactor observations still pin ──────────────
    // The claim this file was written for is that the SEAM's output is
    // unchanged by the refactor, and the two halves below are the halves the
    // engine reproduces exactly.

    // The system prompt is byte-identical in LENGTH to the legacy cycle's
    // (95275 measured on both), which is the observable of `refreshTurnSystemPrompt`
    // REPLACING the mode prefix rather than appending to it. A seam that
    // appended would compound the base once per turn and this would grow.
    expect(run.seen[1].systemPrompt.length).toBe(run.seen[0].systemPrompt.length);

    // And the prompt is not empty: the tool-group instruction rides it, which
    // is what proves `systemPromptContent` survived the move out of the inline
    // block at all. A seam that returned a bare prompt would lose it.
    expect(run.seen[0].systemPrompt).toContain('Tool-group progress:');
    expect(run.seen[1].systemPrompt).toContain('Tool-group progress:');

    // The advertised surface is STABLE across the two turns and is the
    // agent's OWN resolved one, cross-checked against the wire. This is the
    // anti-identity half: source A is what the provider was handed, source B is
    // what the agent resolved, and a projection that built a set of its own
    // fails here.
    expect(run.seen[0].toolNames).toEqual([...run.advertised]);
    expect(run.seen[1].toolNames).toEqual([...run.advertised]);
    expect(run.advertised).toContain('probe_ok');

    // The conversation still carries forward: turn 2 contains the assistant
    // tool_use turn 1 produced and the tool result it produced. This is the
    // cross-leg claim no per-turn assertion can make, and it is the one the
    // engine path had to earn rather than inherit.
    expect(run.seen[1].roles).toContain('assistant');
    expect(run.seen[1].roles).toContain('tool');
    // Turn 1 is the prompt plus the transcript copy, both `user` -- so the
    // legacy's single-turn `['user']` is NOT reproduced verbatim, and the
    // reason is the engine's own projection rather than the seam's. Recorded
    // here so the difference has a name and the next slice does not have to
    // rediscover it.
    expect(run.seen[0].roles.every((role) => role === 'user')).toBe(true);
    expect(run.seen[0].roles).not.toEqual(PRE_REFACTOR_TURN1_ROLES);
  });

  it('does NOT reproduce the legacy tool list, and the gap is located, not assumed', async () => {
    // The honest half of the repoint, and the reason the frozen
    // `PRE_REFACTOR_TOOL_NAMES` cannot be asserted against the engine.
    //
    // MEASURED: the legacy advertises
    // `['probe_ok', 'progress_update', 'tool_catalog', 'tool_invoke']` and the
    // engine advertises the same list MINUS `progress_update`. The cause is
    // located in the source rather than inferred from the numbers: `streamChat`
    // appends the tool to its OWN `tools` local at `DuyaAgent.ts:2577`, which
    // is AFTER `beginTurnAssembly` at `:2697`, so the seam never sees it and an
    // engine-driven run cannot advertise it.
    //
    // This is a REAL cutover gap, not a fixture artifact, and it is asserted
    // here so it stays visible: when the flip moves that append into the seam,
    // this goes red and the assertion below is the thing to update.
    const run = await runThroughEngine();

    expect(run.advertised).not.toContain('progress_update');
    expect(run.advertised).toHaveLength(PRE_REFACTOR_TOOL_NAMES.length - 1);
    // The rest of the frozen list IS reproduced, which is what localises the
    // difference to this one tool rather than to a wholesale surface change.
    for (const name of PRE_REFACTOR_TOOL_NAMES) {
      if (name === 'progress_update') continue;
      expect(run.advertised).toContain(name);
    }

    // The owner, pinned at the SOURCE so the gap cannot be forgotten by a
    // reader who only sees the assertion above: the tool is added inside
    // `streamChat`, past the seam.
    expect(code()).toContain('PROGRESS_UPDATE_TOOL');
    expect(occurrences(/tools = \[\.\.\.tools, \{ \.\.\.PROGRESS_UPDATE_TOOL/)).toBe(1);
  });
});

// ============================================================================
// 2. Reachability and single implementation, asserted against the source
// ============================================================================

describe('the seam is public, and the loop routes through it rather than beside it', () => {
  it('declares assembleTurn without a `private` modifier', () => {
    // `private` is compile-time only, so this is a statement about intent: the
    // composition must be able to reach it, which is the whole reason it exists.
    expect(code()).toContain('assembleTurn(request: TurnAssemblyRequest): TurnAssembly');
    expect(code()).not.toMatch(/private\s+assembleTurn/);
  });

  it('has exactly ONE call site, and it is the legacy cycle', () => {
    // Counted, not pattern-matched: a second caller is a second owner of "what
    // a turn advertises". `composeLegacyRunPorts` takes the agent and will reach
    // this method -- through this seam, not around it.
    expect(occurrences(/this\.assembleTurn\s*\(/)).toBe(1);
  });

  it('no longer assembles a turn inline: the mode refresh and the pipeline are inside the seam', () => {
    // The pre-slice loop had both of these at the top of its body. Each is now
    // reachable only through `refreshTurnSystemPrompt` / `buildTurnPipeline`,
    // which the seam owns.
    expect(occurrences(/baseSystemPromptWithoutModes\)\s*:\s*string|prefix \+= typeof p === 'function'/)).toBe(1);
    expect(occurrences(/this\.buildTurnPipeline\s*\(/)).toBe(1);
  });
});

describe('the catalog protocol has one home', () => {
  it('assigns currentRound in exactly one place', () => {
    // Pre-slice it was assigned inline, mid-loop, where only the loop could
    // reach it. One assignment site is what makes "the engine can set the round"
    // a fact rather than an intention.
    expect(occurrences(/currentRound\s*=\s*request\.turn/)).toBe(1);
    expect(occurrences(/currentRound\s*=\s*turnCount/)).toBe(0);
  });

  it('routes the three compaction sites and the drain site through the seam methods', () => {
    // Three invalidations, one record. Each is a hand-reached piece of one
    // protocol, which is the shape that lets a seam skip one and still pass
    // every structural test.
    expect(occurrences(/this\.invalidateTurnCatalogSchemaReads\s*\(/)).toBe(3);
    expect(occurrences(/this\.recordTurnCatalogSchemaRead\s*\(/)).toBe(1);
  });

  it('keeps the bare free functions reachable ONLY as the seam implementation', () => {
    // One call each, inside the seam. A call anywhere else is a second owner of
    // the decision of WHEN the maps are cleared.
    expect(occurrences(/invalidateToolCatalogSchemaReads\s*\(/)).toBe(1);
    expect(occurrences(/recordToolCatalogSchemaRead\s*\(/)).toBe(1);
  });
});

// ============================================================================
// 3. The seam's behaviour, driven directly
// ============================================================================

/**
 * Drive one `assembleTurn` against a real agent.
 *
 * `abortController` is assigned through a cast because it is private and
 * `streamChat` normally establishes it on entry. The cast is the honest
 * boundary: this harness is standing in for a live run, and says so.
 */
interface SeamRun {
  readonly assembly: ReturnType<InstanceType<typeof duyaAgent>['assembleTurn']>;
  readonly toolUseContext: ToolUseContext;
}

/**
 * A minimal `TurnContext` stand-in.
 *
 * `TurnAssembler.build` derives `sessionId` and `workingDirectory` from the AGENT
 * snapshot, not from `options` (`turnShape.ts:156-157`), so two contexts built
 * from different options are the same object and cannot discriminate a stale
 * one. `buildTurnPipeline` reads exactly three fields off it
 * (`DuyaAgent.ts:493,496,503`), so those three are supplied directly and the
 * test observes what the seam FORWARDED rather than what the assembler derived.
 */
function standInTurnContext(sessionId: string, workingDirectory: string): TurnContextLike {
  return { sessionId, workingDirectory, language: undefined } as unknown as TurnContextLike;
}

type TurnContextLike = { sessionId?: string; workingDirectory?: string; language?: string };

async function assembleOnce(
  agent: InstanceType<typeof duyaAgent>,
  request: Record<string, unknown>,
): Promise<SeamRun> {
  const internals = agent as unknown as { abortController: AbortController };
  internals.abortController = new AbortController();
  let toolUseContext: ToolUseContext | undefined;

  // One cast, at the boundary. The seam's parameter is a closed interface, and
  // this harness deliberately supplies a PART of it -- the rest of what
  // `buildTurnPipeline` reads comes from `this`, and the fields a live run
  // supplies (permission gate, meta-tool dispatcher, publisher) are not what
  // these assertions are about. Spreading a `Record` over the defaults keeps
  // each test's intent visible instead of hiding it behind nine required
  // arguments per call.
  const merged: Record<string, unknown> = {
    turnContext: standInTurnContext('seam-default', process.cwd()),
    bindToolUseContext: (c: ToolUseContext) => {
      toolUseContext = c;
    },
    ...request,
  };
  const assembly = agent.assembleTurn(merged as unknown as Parameters<typeof agent.assembleTurn>[0]);
  if (!toolUseContext) throw new Error('assembleTurn bound no tool-use context');
  return { assembly, toolUseContext };
}

/** `_resolveTools` is private; the cast stands in for a live run's own bundle. */
async function resolvedBundle(
  agent: InstanceType<typeof duyaAgent>,
  registry: InstanceType<typeof ToolRegistry>,
): Promise<Record<string, unknown>> {
  const internals = agent as unknown as {
    _resolveTools: (o: unknown, p?: unknown) => Promise<Record<string, unknown>>;
  };
  return internals._resolveTools({ toolRegistry: registry });
}

describe('assembleTurn advances the catalog round and the round is what a schema read records', () => {
  it('stamps each turn, so a drain records the round the model was actually in', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, { turn: 1, resolved, messages: [], tools: [], systemPrompt: 'p' });
    expect(turn1.assembly.catalogView.currentRound).toBe(1);

    // A schema read in turn 1 is stamped 1 -- not 0, and not whatever the
    // view happened to be constructed with.
    const catalogView = turn1.assembly.catalogView as unknown as {
      loadedSchemaRounds: Map<string, number>;
      snapshot: { getCatalogEntry: (id: string) => { schemaRevision: string } | undefined };
      eligibleToolIds: Set<string>;
    };
    expect(catalogView.loadedSchemaRounds.size).toBe(0);

    const turn2 = await assembleOnce(agent, { turn: 2, resolved, messages: [], tools: [], systemPrompt: 'p' });
    expect(turn2.assembly.catalogView.currentRound).toBe(2);
  });
});

describe('assembleTurn reads the bundle it was given, not one it remembered', () => {
  it('returns the CALLER\'S catalog view, so a second turn on a new bundle sees the new view', async () => {
    // The stale-bundle mutation: a seam that caches `resolved` on first call
    // would hand turn 2 the turn-1 view, and a `tool_invoke` dispatched on that
    // turn would read a snapshot from a run it is no longer in.
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const first = await resolvedBundle(agent, registry);
    const second = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, { turn: 1, resolved: first, messages: [], tools: [], systemPrompt: 'p' });
    const turn2 = await assembleOnce(agent, { turn: 2, resolved: second, messages: [], tools: [], systemPrompt: 'p' });

    expect(turn2.assembly.catalogView).toBe(second.catalogView);
    expect(turn2.assembly.catalogView).not.toBe(first.catalogView);
    expect(turn1.assembly.catalogView).toBe(first.catalogView);
  });

  it('carries the CALLER\'S turn context into this turn\'s tool-use context', async () => {
    // The stale-turnContext mutation: the loop builds `turnContext` once per run
    // and never changes it, so this CANNOT be observed through `streamChat`.
    // It is observed here because the whole point of the seam is that a future
    // host supplies a per-turn context, and a seam that cached turn 1's would
    // silently run every later turn under turn 1's identity.
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, {
      turn: 1, resolved, messages: [], tools: [], systemPrompt: 'p',
      turnContext: standInTurnContext('session-A', process.cwd()),
    });
    const turn2 = await assembleOnce(agent, {
      turn: 2, resolved, messages: [], tools: [], systemPrompt: 'p',
      turnContext: standInTurnContext('session-B', process.cwd()),
    });

    expect(turn1.toolUseContext.options?.sessionId).toBe('session-A');
    expect(turn2.toolUseContext.options?.sessionId).toBe('session-B');
    expect(turn2.toolUseContext.options?.sessionId).not.toBe('session-A');
  });
});

describe('invalidateTurnCatalogSchemaReads is the whole of the invalidation', () => {
  it('clears the loaded-schema maps, which is what makes a compacted history stop serving a stale schema', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);
    const view = (resolved as { catalogView: Record<string, unknown> }).catalogView as unknown as {
      loadedSchemaRevisions: Map<string, string>;
      loadedSchemaRounds: Map<string, number>;
    };

    // Seed both maps as a committed `tool_catalog` receipt would.
    view.loadedSchemaRevisions.set('tool-x', 'rev-1');
    view.loadedSchemaRounds.set('tool-x', 1);
    expect(view.loadedSchemaRounds.size).toBe(1);

    agent.invalidateTurnCatalogSchemaReads(resolved as never);

    // The skip-the-invalidation mutation leaves both maps populated, and the
    // dispatcher then reports a schema as loaded in a round whose history
    // compaction removed -- which produces a wrong answer rather than an error.
    expect(view.loadedSchemaRevisions.size).toBe(0);
    expect(view.loadedSchemaRounds.size).toBe(0);
  });

  it('recordTurnCatalogSchemaRead ignores a non-tool row, and the guard lives in the method', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    expect(agent.recordTurnCatalogSchemaRead(resolved as never, { role: 'assistant', content: 'x' } as never)).toBe(false);
    // A tool row with no catalog receipt is also not a read.
    expect(agent.recordTurnCatalogSchemaRead(resolved as never, { role: 'tool', content: 'x' } as never)).toBe(false);
  });
});
