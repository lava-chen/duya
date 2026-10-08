/**
 * Plan 610 P3: the declared-tools guard on the ENGINE's model leg.
 *
 * ## The silent failure this file exists for
 *
 * `beginTurnAssembly` holds the visibility guard in a closure local, starts it
 * as an EMPTY set, and fills it only when something calls
 * `refreshDeclaredTools`. The legacy filled it from inside
 * `TurnStreamRunner.runTurnStream`, once per attempt, immediately before opening
 * the provider request. The engine never enters that runner: its model leg goes
 * through `createClientModelPort`, and before this slice nothing called the
 * refresh on that path. An empty set denies every name outside it, so every
 * dispatch was refused -- measured: zero tools executed, and the run still
 * proposed `completed`.
 *
 * Every existing harness worked around it by re-snapshotting inside a wrapped
 * `assemble`, which is why the suite was green on a path where no tool could run.
 *
 * ## What is REAL here, and what is not
 *
 * REAL: `duyaAgent`; `beginTurnAssembly` and the guard it closes over;
 * `evaluateVisibilityGuard` as the executor reaches it; the
 * `ToolExecutionPipeline` and `TurnPipelinePublisher`; the side-effect ledger;
 * `composeLegacyRunPorts` and every port it binds; `RunEngineImpl`; the run
 * input straight from `buildLegacyRunInput`, unoverridden.
 *
 * FAKED, and only these two: the PROVIDER (scripted, because a proof needs a
 * model that answers on cue) and the worker's DB IPC (`modeState:get`,
 * `mailbox:claimBatch`). Neither replaces a leg under test.
 *
 * ## Nothing in this file fills the guard
 *
 * That is the whole claim, so it is worth being explicit about what is absent:
 * no wrapper around `assemble`, no `refreshDeclaredTools()` call of the
 * harness's own, no fake pipeline. The host names the handle's refresh once, the
 * way every production host does, and everything after that is the product's.
 *
 * ## The trap this file is built to avoid
 *
 * The assertion is a POSITIVE COUNT of real executions. "No tool error was
 * raised" is satisfied by a mute pipeline that dispatched nothing, and this is
 * exactly the gap that produced it -- a run that refused every call and reported
 * `completed` looks clean to every shape-based check. The refresh count is then
 * compared against the provider's own record of how many requests it was asked
 * for, so "per attempt" is measured rather than assumed: two sources, neither
 * derived from the other.
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

let providerCalls = 0;

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
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      // The count is taken HERE, at the provider's own far end, and nowhere
      // else: it is the second source the refresh count is compared against.
      providerCalls += 1;
      const index = providerCalls - 1;
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
  providerCalls = 0;
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  providerCalls = 0;
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
const RUN_ID = 'run-p3-guard' as RunId;
const SESSION_ID = 's-p3-guard';
const PROMPT = 'run the probe';

/**
 * Register the probe into the AGENT'S OWN registry, and count REAL executions.
 *
 * Not into a registry handed to `_resolveTools`: the engine's side-effect lookup
 * is derived from `agent.activeMCPRegistry`, so a probe in a separate registry
 * would be invisible to it.
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
      execute: async () => {
        runs += 1;
        return { name: PROBE, result: `RAN-${runs}` };
      },
    } as never,
  );
  return { runs: () => runs };
}

interface Proof {
  readonly runs: () => number;
  readonly refreshes: () => number;
  readonly providerCalls: () => number;
  readonly terminals: readonly TerminalCandidate[];
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
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const probe = registerProbe(agent);
  const options = { sessionId: SESSION_ID } as never;
  const turnContext = agent.assembleTurnContext(options, PROMPT);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: PROMPT, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();

  // The REAL production ledger on a temp dir: `sideEffectOf` resolves to
  // `undeclared` for every tool, and the engine refuses any non-`read_only`
  // call with no ledger attached. Without it the tool leg is dead for a
  // different reason and this file would prove nothing.
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-p3-ledger-'));
  ledgerDirs.push(ledgerDir);
  const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });

  // THE UNWRAPPED HANDLE. No `assemble` wrapper, no harness-side refresh: the
  // guard is filled by the model leg or by nobody.
  const handle = await agent.beginTurnAssembly({
    options,
    prompt: PROMPT,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  // Counted at the HOST's seam, not the port's, so the number compared below is
  // "how often a production host would be asked to re-snapshot" rather than a
  // restatement of what the port did internally.
  let refreshes = 0;

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-p3',
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
    manifestHash: 'hash-p3',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'p3-guard', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(handle),
    refreshDeclaredTools: () => {
      refreshes += 1;
      return handle.refreshDeclaredTools();
    },
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-p3',
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
    revision: 'rev-p3',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const input: RunInputSnapshot = buildLegacyRunInput(
    facts,
    { role: 'user', id: 'p1', content: PROMPT },
    [],
  );

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine
    .execute({ manifest: buildLegacyRunManifest(facts), input, signal: new AbortController().signal, ports })
    .completed();

  turnPipelines.close();

  return {
    runs: probe.runs,
    refreshes: () => refreshes,
    providerCalls: () => providerCalls,
    terminals,
  };
}

// ============================================================================
// THE PROOF
// ============================================================================

describe("the engine's model leg re-takes the declared-tools snapshot", () => {
  it('dispatches the model\'s tool call with nothing filling the guard but the model leg', async () => {
    const proof = await runThroughEngine();

    // THE claim, as a POSITIVE COUNT of real executions. On the pre-fix tree the
    // guard is empty, `evaluateVisibilityGuard` refuses the name, the executor
    // reports a `tool_error`, and this is 0 -- while the run below still reaches
    // `completed`, which is the whole shape of the defect.
    expect(proof.runs()).toBe(1);

    // And the run was not short-circuited to make that number one: the tool
    // result took the run to a second request, which is what a result arriving
    // looks like from outside.
    expect(proof.providerCalls()).toBe(2);
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    // PER ATTEMPT, measured across two sources. The refresh count is taken at
    // the host's seam and the request count at the provider's, so this is not a
    // value compared with itself: a port that refreshed once per RUN would show
    // 1 against 2, and one that refreshed nothing would show 0.
    expect(proof.refreshes()).toBe(proof.providerCalls());
  });
});