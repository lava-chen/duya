/**
 * Plan 610 P2: the run input's HISTORY, on the real composition path.
 *
 * ## The silent failure this file exists for
 *
 * `buildLegacyRunInput` emitted `history: { kind: 'inline', value }` while the
 * catalog beside it was `by_ref` with a digest and a locator. The engine treats
 * the two shapes differently -- `RunEngineImpl.#modelRequest` reads
 * `input.history.value` when the part is inline and falls back to
 * `assembled.messages` for a `by_ref` -- and an inline part is FROZEN at run
 * start. So on the engine-driven path the tool result turn 1 produced could
 * never reach turn 2: the tool ran, the run proposed `completed`, and turn 2's
 * request was `["user"]`.
 *
 * Every existing proof harness overrode the field to `by_ref` by hand, which is
 * exactly why the gap was invisible to the suite: the harness was supplying the
 * thing the builder did not.
 *
 * ## What is REAL here, and what is not
 *
 * REAL: `duyaAgent`; `beginTurnAssembly` and the assembly seam; the visibility
 * guard; `ToolExecutionPipeline` and `TurnPipelinePublisher`; the side-effect
 * ledger; `composeLegacyRunPorts` and every port it binds; `RunEngineImpl`;
 * `buildLegacyRunInput` as the run's ONLY source of its input snapshot.
 *
 * FAKED, and only these two: the PROVIDER (scripted, because a proof needs a
 * model that answers on cue -- it only RECORDS what it was handed) and the
 * worker's DB IPC (`modeState:get`, `mailbox:claimBatch`).
 *
 * ## The one manual refresh, and why it is here rather than in the source
 *
 * The declared-tools guard is a separate gap (plan 610 P3): it starts empty and
 * denies every name outside it, and the engine's model leg does not re-take the
 * snapshot. Without a refresh somewhere, the probe never dispatches, there is no
 * tool result, and this file would be measuring an empty transcript for a
 * different reason. So the harness refreshes it inside `assemble`, exactly as
 * the sibling proof does, and the ONLY thing under test here is where the
 * history comes from. Nothing in the run input is overridden.
 *
 * ## The trap this file is built to avoid
 *
 * Every leg assertion is a POSITIVE COUNT. A run whose guard denied every call
 * would reach no tool result and could still satisfy "the request did not
 * contain a tool result" -- so `probe.runs() === 1` is asserted FIRST, and the
 * claim under test is made about the TEXT the tool produced rather than about a
 * role list.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { RunEnginePorts, RunInputSnapshot, TerminalCandidate } from '@duya/agent-runtime';
import type { RunFence, RunId } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER -- the only fake standing in for a leg's far end
// ============================================================================

interface Seen {
  readonly roles: string[];
  /** Every message's content as the provider was handed it, stringified. */
  readonly contents: readonly string[];
}

let active: { seen: Seen[] } | null = null;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
/** Turn 1 asks for the probe; turn 2 reports and stops. */
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
        contents: messages.map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ),
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

/** Ledger temp dirs, removed after the test so a failing run leaves nothing. */
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's
 * own listener is called directly -- the pool's would try to deserialize a plain
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
/** The string only the probe's own executor can produce. */
const PROBE_OUTPUT = 'RAN-1';

const RUN_ID = 'run-p2-history' as RunId;
/** The run's own session, and the source the locator assertion compares against. */
const SESSION_ID = 's-p2-history';
const PROMPT = 'run the probe';

/**
 * A second run's input over the SAME session, for the digest claim.
 *
 * Separate from the run under proof on purpose: the digest has to be a function
 * of what the locator resolved to, and that is a claim about two DIFFERENT
 * inputs rather than about the one run this file drives.
 */
function inputOver(history: Parameters<typeof buildLegacyRunInput>[2]): RunInputSnapshot {
  return buildLegacyRunInput(
    {
      runId: RUN_ID,
      cwd: process.cwd(),
      model: 'claude-test',
      providerId: 'anthropic',
      sessionId: SESSION_ID,
      projectId: null,
      revision: 'rev-p2',
      catalogRevision: 7,
      permissionMode: 'default',
    },
    { role: 'user', id: 'p1', content: PROMPT },
    history,
  );
}

/**
 * Register the probe into the AGENT'S OWN registry, and count REAL executions.
 *
 * Not into a registry handed to `_resolveTools`: the engine's side-effect lookup
 * is derived from `agent.activeMCPRegistry`, so a probe living in a separate
 * `options.toolRegistry` would be invisible to it.
 */
function registerProbe(agent: InstanceType<typeof duyaAgent>): { readonly runs: () => number } {
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
        return { id: String(input.id ?? 'none'), name: PROBE, result: PROBE_OUTPUT };
      },
    } as never,
  );
  return { runs: () => runs };
}

interface Proof {
  readonly calls: () => number;
  readonly seen: readonly Seen[];
  readonly runs: () => number;
  readonly terminals: readonly TerminalCandidate[];
  readonly input: RunInputSnapshot;
}

async function runThroughEngine(): Promise<Proof> {
  installFakeDbIpc();

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  // The live run's setup, in the order the legacy sets it up. `streamChat`
  // normally owns this; a host driving the engine does it instead.
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const probe = registerProbe(agent);
  const options = { sessionId: SESSION_ID } as never;
  const turnContext = agent.assembleTurnContext(options, PROMPT);

  // The user prompt enters the transcript before the engine assembles its first
  // turn, which is the agent's own store and not the input snapshot's business.
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: PROMPT, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  // Published before the handle is established: `buildTurnPipeline` publishes
  // each turn's pipeline into it and the engine's tool leg drains from it.
  const turnPipelines = new TurnPipelinePublisher();

  // The REAL production ledger on a temp dir, for the reason the sibling proof
  // gives: `sideEffectOf` resolves to `undeclared` for every tool, and the
  // engine refuses any non-`read_only` call with no ledger attached.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-p2-ledger-'));
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
    prompt: PROMPT,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  // The ONE manual refresh, and it is the declared-tools gap's to fix rather
  // than this file's. See the header.
  const realAssemble = handle.assemble.bind(handle);
  const observedHandle = {
    ...handle,
    assemble(input: Parameters<typeof realAssemble>[0]) {
      const assembly = realAssemble(input);
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-p2',
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
    manifestHash: 'hash-p2',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'p2-history', version: '0.0.0' },
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
      nextCompactionId: () => 'cmp-p2',
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
    sessionId: SESSION_ID,
    projectId: null,
    revision: 'rev-p2',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest = buildLegacyRunManifest(facts);

  // NO OVERRIDE. This is the whole file: whatever `buildLegacyRunInput` says
  // about the history is what the run gets.
  const input: RunInputSnapshot = buildLegacyRunInput(
    facts,
    { role: 'user', id: 'p1', content: PROMPT },
    [],
  );

  active = { seen: [] };
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine
    .execute({ manifest, input, signal: new AbortController().signal, ports })
    .completed();

  turnPipelines.close();

  return {
    calls: () => active?.seen.length ?? 0,
    seen: active?.seen ?? [],
    runs: probe.runs,
    terminals,
    input,
  };
}

// ============================================================================
// THE PROOF
// ============================================================================

describe('the run input carries a VERIFIABLE history reference', () => {
  it('feeds the tool result turn 1 produced BACK into turn 2\'s request', async () => {
    const proof = await runThroughEngine();

    // POSITIVE COUNTS FIRST. A guard that denied every call would leave an empty
    // request here and could still satisfy "no tool result in turn 2", so the
    // dispatch and the second request are asserted as facts of their own.
    expect(proof.runs()).toBe(1);
    expect(proof.calls()).toBe(2);

    // The run still reports the terminal it always reported -- which is what
    // made the gap silent. Asserted so a reader can see the whole shape: a
    // `completed` run that never told the model what its tool returned.
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    // THE claim, and it is deliberately not "the output text appears somewhere
    // in turn 2". The inter-turn rail carries a `user` reminder that QUOTES the
    // last tool result, so a substring search passes on the broken build too --
    // measured: on the pre-fix source the request was exactly `["user"]` and that
    // one row's text contained the probe's output.
    //
    // What an inline history cannot produce is the RESULT ROW itself, so the
    // claim is made about that row: it is in the request, its text is what the
    // probe's own executor printed, and it follows the assistant row that asked
    // for the call. Cross-source throughout -- the literal comes from the probe's
    // executor, the request from what the scripted provider recorded.
    const turn2 = proof.seen[1];
    const toolRow = turn2.roles.indexOf('tool');
    expect(toolRow).toBeGreaterThan(-1);
    expect(turn2.contents[toolRow]).toContain(PROBE_OUTPUT);
    expect(turn2.roles.lastIndexOf('assistant', toolRow)).toBeGreaterThan(-1);

    // Turn 1 asked for the call and must not already carry its result, so the
    // assertion above is about something turn 1 could not have supplied.
    expect(proof.seen[0].roles).not.toContain('tool');

    // The reference itself, and both halves of it. `kind` is what makes the
    // engine re-resolve instead of replaying a frozen array; the locator NAMES
    // the durable transcript, and it is compared against the session THIS FIXTURE
    // configured rather than against a value read back off the output.
    const reference = historyRef(proof.input);
    expect(reference.kind).toBe('by_ref');
    expect(reference.locator).toBe(`transcript://${SESSION_ID}`);

    // The digest is a FUNCTION of what the locator resolved to, not a constant
    // that satisfies the type. The same rows pin the same digest and different
    // rows pin a different one, and it is the protocol's own sha256 -- a
    // placeholder string would fail all three.
    const first = inputOver([{ role: 'user', id: 'h1', content: 'earlier question' }]);
    const same = inputOver([{ role: 'user', id: 'h1', content: 'earlier question' }]);
    const other = inputOver([{ role: 'user', id: 'h1', content: 'a different earlier question' }]);
    expect(historyRef(first).digest).toMatch(/^[0-9a-f]{64}$/);
    expect(historyRef(first).digest).toBe(historyRef(same).digest);
    expect(historyRef(first).digest).not.toBe(historyRef(other).digest);
  });
});

/**
 * The `by_ref` half of a snapshot's history.
 *
 * `expect(...).toBe('by_ref')` does not narrow a union, so the narrowing is
 * done here once and every reader gets the reference type. Throwing rather than
 * returning `null` keeps the assertions below reading as claims about the value.
 */
function historyRef(input: RunInputSnapshot) {
  if (input.history.kind !== 'by_ref') {
    throw new Error(`history is not a reference: ${input.history.kind}`);
  }
  return input.history;
}