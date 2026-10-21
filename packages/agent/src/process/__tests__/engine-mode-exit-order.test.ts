/**
 * Plan 610 D5: a mode's `onExit` sits BETWEEN the `before_commit` contribution
 * and its durable write -- asserted as an ORDER, not as "both happened".
 *
 * ## Why an order assertion and not a pair of existence assertions
 *
 * `run-engine.ts`'s mode-exit call site argues its position at length: the
 * legacy runs `PostTurn` -> `runExitHooks` -> `_commitMessages`
 * (`SessionFinalizer.ts:226`, `:235`, `:245`), so a mode's teardown "observes
 * the `PostTurn` effects and precedes the durable write of them". A test that
 * asserted only "the contributor ran" and "the mode exited" would pass for a
 * `#shouldStop` that had moved the mode exit into the run's `finally`, or after
 * the commit, or before the contribution -- every one of which is a different
 * behaviour with the same two observable outcomes.
 *
 * So the assertion here is on a single ORDERED LOG that all three parties
 * append to, and it is checked as an exact sequence. That is the only shape in
 * which "the mode exit saw the contribution but not its durable row" is a fact
 * rather than an inference.
 *
 * ## The three parties, and why each one appends
 *
 * 1. `before_commit`'s real `ExtensionContributor` body appends `contribute`.
 * 2. A real `ModeExitPort` appends `modeExit`. The port is bound through
 *    `composeLegacyRunPorts`, so the engine really calls the composition's
 *    `agent.runModeExitHooks()`; the mode is a REAL registration in the REAL
 *    `modeModifierRegistry`, and `onExit` is the mode's own hook body.
 * 3. The COMMIT appends `commit`, tapped around the composed port's own
 *    `recordInjectedMessage` -- the product's real `agent.addMessage` still
 *    runs; the tap only records that it ran and when.
 *
 * ## What is REAL here
 *
 * A real `duyaAgent`; `beginTurnAssembly` / `assembleTurn`; a real mode
 * resolved by the agent's own `applyTurnModes`; `composeLegacyRunPorts` and
 * every port it binds; the real `TurnOutputPort.recordInjectedMessage`; and the
 * real `RunEngineImpl` loop. The counter that decides the test is the ORDER of
 * three side effects the engine genuinely performed.
 *
 * FAKED, and only the PROVIDER and the worker's DB IPC -- both recorded in the
 * harness, neither replacing a leg under test.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type {
  ExtensionContribution,
  ExtensionContributor,
  ExtensionPort,
  RunEnginePorts,
  RunInputSnapshot,
  TerminalCandidate,
} from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER
// ============================================================================

let providerScript: readonly SSEEvent[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of providerScript) {
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
// The offline host. The dynamic-import ORDER is load-bearing: `PRE_EXISTING`
// must be captured BEFORE `initDbClient` registers its own listener.
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';
import type { ModeModifierContext } from '../../modes/types.js';

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
      throw new Error(`unexpected db action in the mode-exit-order proof: ${req.action}`);
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
  providerScript = [{ type: 'text', data: 'the model answered' }, DONE];
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

// ============================================================================
// A REAL mode, registered in the REAL registry
// ============================================================================

const MODE_ID = 'd5-mode-exit-order-probe';

/**
 * The ordered log. THE CLAIM.
 *
 * Every entry is appended by a side effect the engine really performed, in the
 * order it performed it. Asserted as an exact sequence, so a `#shouldStop`
 * that moved the mode exit anywhere else changes this array rather than
 * quietly satisfying a weaker pair of existence checks.
 */
let order: string[] = [];

/** How many times the mode's own `onExit` BODY ran. A POSITIVE COUNT. */
let exitCalls = 0;

/** How many times the contributor's own body ran. A POSITIVE COUNT. */
let contributeCalls = 0;

async function registerOrderMode(): Promise<void> {
  const { modeModifierRegistry } = await import('../../modes/registry.js');
  try {
    modeModifierRegistry.register({
      id: MODE_ID,
      // `message`, and not `session`: `runExitHooks` filters on exactly this
      // (`apply-modes.ts`), so a `session` mode would prove nothing here and the
      // ordering assertion would pass for the wrong reason.
      kind: 'message',
      hooks: {
        onExit: (_ctx: ModeModifierContext) => {
          order.push('modeExit');
          exitCalls += 1;
        },
      },
    } as never);
  } catch (error) {
    if (!/already registered/.test(String(error))) throw error;
  }
}

const PROBE_TEXT = 'the before_commit contributor said this at the end of the turn';

/**
 * A REAL `before_commit` contributor. Carried as the object the engine is
 * handed, so "the phase fired nobody" cannot be a fixture that silently has no
 * `contribute` on it.
 */
function commitContributor(): ExtensionContributor {
  return {
    id: 'order:1',
    phase: 'before_commit',
    order: 0,
    timeoutMs: 1_000,
    async contribute(): Promise<readonly ExtensionContribution[]> {
      contributeCalls += 1;
      order.push('contribute');
      return [{ key: 'order:1:0', content: { kind: 'hook_context', key: 'order:1:0', text: PROBE_TEXT }, binding: false }];
    },
  };
}

const extensionsPort: ExtensionPort = {
  list: (phase) => (phase === 'before_commit' ? [commitContributor()] : []),
  unload: () => Promise.resolve(),
};

const RUN_ID = 'run-d5-mode-exit-order' as RunId;
let sessionSeq = 0;

interface Proof {
  /** THE ORDERED LOG. The claim, observed. */
  readonly order: readonly string[];
  readonly exits: () => number;
  readonly contributes: () => number;
  /** The durable transcript, read back off the agent's own timeline. */
  readonly transcript: () => readonly Message[];
  readonly terminals: readonly TerminalCandidate[];
}

/**
 * Drive a real `RunEngineImpl` over real composed ports with a real agent, a
 * real registered mode and a real `before_commit` contributor, and report the
 * ORDER the engine performed the three finalize-boundary effects in.
 *
 * Deliberately the same harness shape as `engine-mode-exit-port.test.ts`,
 * including the handle-bound `refreshDeclaredTools` the model leg calls per
 * attempt (plan 610 P3): a proof that differs from a proven harness in its
 * SETUP proves a different thing than it claims.
 */
async function runOnce(): Promise<Proof> {
  installFakeDbIpc();
  await registerOrderMode();
  order = [];
  exitCalls = 0;
  contributeCalls = 0;

  const seq = (sessionSeq += 1);
  const sessionId = `s-d5-order-${seq}`;
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const options_ = { sessionId, mode: MODE_ID } as never;
  const prompt = 'use the mode';
  const turnContext = agent.assembleTurnContext(options_, prompt);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-d5-order-'));
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
    prompt,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-d5-order',
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
    manifestHash: 'hash-d5-order',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'mode-exit-order', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
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
      nextCompactionId: () => 'cmp-d5',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId,
    workingDirectory: process.cwd(),
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
    extensions: extensionsPort,
  };

  const composed: RunEnginePorts = composeLegacyRunPorts(agent, host);

  // The COMMIT tap, wrapped AROUND the product's own port exactly as
  // `engine-before-commit-phase.test.ts` does: the row still goes through
  // `agent.addMessage` as an un-tapped run would, and the tap only records WHEN.
  const commit = composed.turnOutput!.recordInjectedMessage;
  const ports: RunEnginePorts = {
    ...composed,
    turnOutput: {
      ...composed.turnOutput!,
      recordInjectedMessage: (record) => {
        order.push('commit');
        return commit(record);
      },
    },
  };

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-d5-order',
    projectId: null,
    revision: 'rev-d5',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    history: { kind: 'by_ref', digest: 'hist-d5', locator: 'agent://transcript' },
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
    order: [...order],
    exits: () => exitCalls,
    contributes: () => contributeCalls,
    transcript: () => agent.getMessages(),
    terminals,
  };
}

// ============================================================================
// The claim
// ============================================================================

describe('the position of a mode onExit at the finalize boundary', () => {
  it('runs AFTER the before_commit contribution and BEFORE its durable write', async () => {
    const proof = await runOnce();

    // NON-VACUITY FIRST. A run that reached neither the contributor nor the
    // mode would produce an empty log, and an empty log satisfies no ordering
    // claim -- it satisfies "nothing happened".
    expect(proof.contributes()).toBe(1);
    expect(proof.exits()).toBe(1);
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    // THE ORDER, as an exact sequence.
    //
    // `contribute` before `modeExit`: a mode's teardown runs after the
    // finalize-boundary contribution exists, matching the legacy's
    // `PostTurn` -> `runExitHooks` order (`SessionFinalizer.ts:226`, `:235`).
    //
    // `modeExit` before `commit`: the teardown precedes the durable write, so a
    // mode cannot read a timeline the run has already persisted. This is the
    // half an existence-pair assertion cannot see -- a mode exit moved after
    // `#commitContributions` still produces both effects, just in the other
    // order, and this array is where that shows up.
    expect(proof.order).toEqual(['contribute', 'modeExit', 'commit']);

    // And the consequence of the order, read off the agent's own transcript
    // rather than off the tap: the row IS durable once the run is over. Stated
    // because an ordering log that held while the row was never written would
    // pin a sequence of no effects.
    const committed = proof.transcript().filter(
      (message) => typeof message.content === 'string' && message.content.includes(PROBE_TEXT),
    );
    expect(committed).toHaveLength(1);
  });

  it('does not fire the mode exit for a FAILED run, so the order above is the success path only', async () => {
    // The control that stops the ordering assertion above from being read as
    // "the mode exit always happens somewhere". `runExitHooks` is reached from
    // `finalizeSuccess` alone (`SessionFinalizer.ts:235`), so a run that failed
    // before finishing a turn must not exit a mode -- and therefore must not
    // contribute a `modeExit` entry to an ordering claim about the success
    // path.
    installFakeDbIpc();
    await registerOrderMode();
    order = [];
    exitCalls = 0;
    contributeCalls = 0;

    const seq = (sessionSeq += 1);
    const sessionId = `s-d5-order-fail-${seq}`;
    const agent = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId,
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });
    (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

    const options_ = { sessionId, mode: MODE_ID } as never;
    const prompt = 'use the mode';
    const turnContext = agent.assembleTurnContext(options_, prompt);
    agent.setMessages([
      ...agent.getMessages(),
      { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
    ]);

    const turnPipelines = new TurnPipelinePublisher();
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-d5-order-fail-'));
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
      prompt,
      appliedProfile: undefined,
      turnContext,
      publisher: turnPipelines,
    });

    const session = new RunSession({
      runId: RUN_ID,
      sessionId: 'sess-d5-order-fail',
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
      manifestHash: 'hash-d5-order-fail',
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'mode-exit-order', version: '0.0.0' },
    });

    const terminals: TerminalCandidate[] = [];
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
        nextCompactionId: () => 'cmp-d5-fail',
      },
      seqIndex: 0,
      wakeRun: false,
      sessionId,
      workingDirectory: process.cwd(),
      beginTicket: (call) => ledger.begin(call),
      settleTicket: (input) => ledger.settle(input),
      extensions: extensionsPort,
    };

    const composed = composeLegacyRunPorts(agent, host);
    const commit = composed.turnOutput!.recordInjectedMessage;
    const ports: RunEnginePorts = {
      ...composed,
      turnOutput: {
        ...composed.turnOutput!,
        recordInjectedMessage: (record) => {
          order.push('commit');
          return commit(record);
        },
      },
    };

    const facts: LegacyRunFacts = {
      runId: RUN_ID,
      cwd: process.cwd(),
      model: 'claude-test',
      providerId: 'anthropic',
      sessionId: 'sess-d5-order-fail',
      projectId: null,
      revision: 'rev-d5-fail',
      catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
      permissionMode: 'default',
    };
    const input: RunInputSnapshot = {
      ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
      history: { kind: 'by_ref', digest: 'hist-d5-fail', locator: 'agent://transcript' },
    } as unknown as RunInputSnapshot;

    // A fatal frame, so the run ends `failed` on turn 1 and never reaches the
    // finalize boundary the ordering claim is about.
    providerScript = [{ type: 'error', data: 'the provider failed' } as unknown as SSEEvent];

    const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
    await engine.execute({
      manifest: buildLegacyRunManifest(facts),
      input,
      signal: new AbortController().signal,
      ports,
    }).completed();
    turnPipelines.close();

    // The run really failed -- otherwise this arm proves nothing, because a
    // `completed` run SHOULD exit the mode.
    expect(terminals).toHaveLength(1);
    expect(terminals[0].state.status).not.toBe('completed');
    // So none of the three finalize-boundary effects fired, and the mode exit
    // is absent from the log rather than merely late in it.
    expect(order).toEqual([]);
    expect(exitCalls).toBe(0);
    expect(contributeCalls).toBe(0);
  });
});
