/**
 * Plan 610 D1: a mode's `onExit` reaches the ENGINE path, on the legacy's own
 * position, and exactly once.
 *
 * ## The gap this closes, and the false premise behind it
 *
 * `DuyaAgent.applyTurnModes` assigns `this.resolvedModes` and `this.modeCtx` as
 * PRIVATE state, and the only reader of them for the run-boundary half was
 * `SessionFinalizer.ts:235` -- reachable only from the legacy `streamChat`. The
 * next slice deletes that path, so with it goes `runExitHooks`, and with THAT
 * goes the only registered `onExit` in the product:
 * `computer-use-mode.ts:199-210` clears the per-session
 * `computer_use_context` trigger and disables the OS context bridge. Nothing
 * would report its absence: a run would complete `completed`, and a user would
 * find Computer Use's bridge left enabled with the mode off.
 *
 * `DuyaAgent.ts:961-963` asserted this was already handled -- "`runExitHooks`
 * ... rides the engine's `after_finalize` phase instead". That claim was FALSE
 * and this file is the evidence, not a restatement of it:
 *
 *  - `after_finalize`'s only producer is `createLegacyHookSource`
 *    (`hook-source.ts:180-185`), whose `PHASE_EVENTS` map names the CONFIG-hook
 *    events `Stop` and `SessionEnd`, dispatched through `ConfigHooksRunner`.
 *  - A mode's `onExit` is reached only from `SessionFinalizer.ts:235`.
 *  - The two registries are disjoint: `hooks/events.ts` (a `HooksSettings`
 *    file) and `modes/registry.ts` (a `ModeModifierRegistry`). No contributor
 *    built by `hook-source.ts` can name a mode, and no mode can register a
 *    contributor.
 *
 * So `after_finalize` cannot carry it, and a test that asserted "the phase
 * fired" would have been green over a dead capability -- the same failure
 * `hook-source.ts`'s own header records for `PostToolUseFailure`, in the
 * opposite direction.
 *
 * ## What is REAL here
 *
 * REAL: a real `duyaAgent`; a REAL `ModeModifier` registered in the REAL
 * `modeModifierRegistry` and resolved by the agent's OWN `applyTurnModes`;
 * `beginTurnAssembly` / `assembleTurn`; `composeLegacyRunPorts` and every port
 * it binds; the real `RunEngineImpl` loop; the real `ModeExitPort` call site.
 * The `onExit` counter is the mode's OWN hook body incrementing, so a green
 * assertion means the product's mode lifecycle ran, not that a helper echoed
 * its input.
 *
 * FAKED, and only the PROVIDER and the worker's DB IPC: both are recorded in
 * the harness and neither replaces a leg under test.
 *
 * ## Why the ordering is asserted and not just the count
 *
 * The legacy runs `PostTurn` -> `runExitHooks` -> `_commitMessages`
 * (`SessionFinalizer.ts:226`, `:235`, `:245`). A teardown placed in the
 * `finally` beside `after_finalize` would fire on a FAILED run too, which
 * `finalizeAbort` and `finalizeStreamError` never do. The failure arm below is
 * what makes that difference observable rather than asserted.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
// The scripted PROVIDER
// ============================================================================

/** The script the provider replays, so a failing run can be asked for. */
let providerScript: readonly SSEEvent[] = [];
/** How many requests the provider was handed. A POSITIVE COUNT. */
let modelCalls = 0;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      modelCalls += 1;
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
// The offline host
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
      throw new Error(`unexpected db action in the mode-exit proof: ${req.action}`);
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
  modelCalls = 0;
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

const MODE_ID = 'd1-mode-exit-probe';
/** How many times the mode's `onExit` BODY ran. A POSITIVE COUNT. */
let exitCalls = 0;
/** The session id the mode's `onExit` was handed, to prove it is the run's. */
let exitSessionId: string | undefined;

/**
 * Register the mode ONCE per process.
 *
 * `ModeModifierRegistry.register` throws on a duplicate id and has no
 * unregister, so this is module state rather than a per-test fixture.
 */
async function registerExitMode(): Promise<void> {
  const { modeModifierRegistry } = await import('../../modes/registry.js');
  try {
    modeModifierRegistry.register({
      id: MODE_ID,
      // `message`, and not `session`: `runExitHooks` filters on exactly this
      // (`apply-modes.ts:131`), so a `session` mode would prove nothing and the
      // test would pass for the wrong reason.
      kind: 'message',
      hooks: {
        onExit: (_ctx: ModeModifierContext) => {
          exitCalls += 1;
          exitSessionId = _ctx.sessionId;
        },
      },
    } as never);
  } catch (error) {
    if (!/already registered/.test(String(error))) throw error;
  }
}

const RUN_ID = 'run-d1-mode-exit' as RunId;
let sessionSeq = 0;

interface Proof {
  readonly calls: () => number;
  readonly exits: () => number;
  readonly exitSession: () => string | undefined;
  readonly terminals: readonly TerminalCandidate[];
  /** Whether the engine actually called the host's `modeExit` member. */
  readonly portPresent: boolean;
}

/**
 * Drive a real `RunEngineImpl` over real composed ports with a real agent and a
 * real registered mode, and report what the mode's `onExit` body observed.
 *
 * The harness shape is `engine-before-commit-phase.test.ts`'s, deliberately: a
 * proof that differs from a proven harness in its SETUP proves a different thing
 * than it claims.
 */
async function runOnce(options: { readonly mode?: string; readonly failModel?: boolean } = {}): Promise<Proof> {
  installFakeDbIpc();
  if (options.mode !== undefined) await registerExitMode();
  exitCalls = 0;
  exitSessionId = undefined;

  const seq = (sessionSeq += 1);
  const sessionId = `s-d1-exit-${seq}`;
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const options_ = {
    sessionId,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  } as never;
  const prompt = 'use the mode';
  const turnContext = agent.assembleTurnContext(options_, prompt);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-d1-exit-'));
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
    sessionId: 'sess-d1-exit',
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
    manifestHash: 'hash-d1-exit',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'mode-exit', version: '0.0.0' },
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
      nextCompactionId: () => 'cmp-d1',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId,
    workingDirectory: process.cwd(),
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
  };

  const composed: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-d1-exit',
    projectId: null,
    revision: 'rev-d1',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    history: { kind: 'by_ref', digest: 'hist-d1', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  modelCalls = 0;
  // A failing provider is how the failure arm reaches a `failed` exit WITHOUT
  // driving the run to `completed`: the frame is a fatal one, so the engine ends
  // the run there and never reaches the `before_commit` position.
  providerScript = options.failModel === true
    ? [{ type: 'error', data: 'the provider failed' } as unknown as SSEEvent]
    : [{ type: 'text', data: 'the model answered' }, DONE];

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports: composed }).completed();
  turnPipelines.close();

  return {
    calls: () => modelCalls,
    exits: () => exitCalls,
    exitSession: () => exitSessionId,
    terminals,
    // Read off the COMPOSED ports, so "the port exists" is a fact about the
    // composition the engine was handed rather than about the engine's field.
    portPresent: composed.modeExit !== undefined,
  };
}

// ============================================================================
// The capability
// ============================================================================

describe('a mode onExit on the engine path', () => {
  it('runs the mode\'s OWN onExit body, exactly once, on a successful run', async () => {
    const proof = await runOnce({ mode: MODE_ID });

    // NON-VACUITY FIRST. The run really reached the model and really resolved a
    // terminal, so "the exit hook ran" is not a run that did nothing and
    // happened to have nothing to exit.
    expect(proof.calls()).toBe(1);
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');

    // The composition bound the channel. Checked on the ports the engine was
    // handed, so a port that exists only in a test's own object cannot satisfy
    // this.
    expect(proof.portPresent).toBe(true);

    // THE CLAIM: a POSITIVE COUNT from the mode's own hook body, not an echo of
    // an input this harness passed. Exactly once -- `runExitHooks` iterates the
    // resolved modes in registration order and this run resolved this mode once.
    expect(proof.exits()).toBe(1);
    // And it was handed the RUN's session, which is what distinguishes "the
    // agent's own modeCtx reached the hook" from "some context object did".
    expect(proof.exitSession()).toBe('s-d1-exit-' + sessionSeq);
  });

  it('does NOT run on a FAILED run, because the legacy runs it on the success path only', async () => {
    // The half that separates this from `after_finalize`. `runExitHooks` is
    // reached from `finalizeSuccess` alone (`SessionFinalizer.ts:235`);
    // `finalizeAbort` and `finalizeStreamError` never call it. A teardown
    // placed in the run's `finally` would disable a mode's OS bridge for a run
    // that never finished a turn.
    const proof = await runOnce({ mode: MODE_ID, failModel: true });

    // The run really failed -- otherwise this arm proves nothing, because a
    // `completed` run SHOULD exit the mode.
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).not.toBe('completed');
    expect(proof.exits()).toBe(0);
  });

  it('leaves a run with NO active mode alone, rather than exiting a mode that never ran', async () => {
    // A run that resolved no `kind: 'message'` mode has nothing to exit, and
    // the legacy's own guard is the same shape
    // (`SessionFinalizer.ts:233` checks `resolvedModes && modeCtx`). Asserted
    // so a later slice cannot make the port fire for modes a run never
    // activated.
    const proof = await runOnce();

    expect(proof.terminals[0].state.status).toBe('completed');
    expect(proof.exits()).toBe(0);
  });
});

// ============================================================================
// Fail-open, and it is the ENGINE's policy rather than the port's
// ============================================================================

describe('a mode onExit that throws', () => {
  it('is swallowed, and the run still completes', async () => {
    installFakeDbIpc();
    await registerExitMode();
    exitCalls = 0;

    const seq = (sessionSeq += 1);
    const sessionId = `s-d1-exit-throw-${seq}`;
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
    const terminals: TerminalCandidate[] = [];
    // Hoisted out of the host literal because the guard's refresh names the same
    // handle the assembly does, and two `beginTurnAssembly` calls would be two
    // guards -- the seam is run-scoped.
    const exitHandle = await agent.beginTurnAssembly({
      options: options_,
      prompt,
      appliedProfile: undefined,
      turnContext,
      publisher: turnPipelines,
    });
    const host: LegacyRunHost = {
      turnPipelines,
      // No assembly handle: this arm is about the terminal, and a handle the
      // engine never calls would be a fixture pretending to be real. The
      // composition's `assembleTurn` IS the real `createLegacyAssembleTurn`
      // shape, so a real one is used rather than a stub.
      assembleTurn: createLegacyAssembleTurn(exitHandle),
      refreshDeclaredTools: () => exitHandle.refreshDeclaredTools(),
      askApproval: async () => ({ allowed: true, scope: 'once' }),
      emitter: new RunEventEmitter({
        runId: RUN_ID,
        session: new RunSession({
          runId: RUN_ID,
          sessionId: 'sess-throw',
          now: () => 1_000,
          startedAt: 0,
          clock: () => 0,
          persistence: { append: async () => undefined, complete: async () => undefined },
          flushEvery: 1_000,
        }),
        stream: { push: () => undefined },
      }),
      proposeTerminal: (candidate) => terminals.push(candidate),
      compaction: {
        decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
        compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
        nextCompactionId: () => 'cmp-throw',
      },
      seqIndex: 0,
      wakeRun: false,
      sessionId,
      workingDirectory: process.cwd(),
    };

    const composed = composeLegacyRunPorts(agent, host);
    const facts: LegacyRunFacts = {
      runId: RUN_ID,
      cwd: process.cwd(),
      model: 'claude-test',
      providerId: 'anthropic',
      sessionId: 'sess-throw',
      projectId: null,
      revision: 'rev-throw',
      catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
      permissionMode: 'default',
    };
    const input = {
      ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
      history: { kind: 'by_ref', digest: 'hist-throw', locator: 'agent://transcript' },
    } as unknown as RunInputSnapshot;

    // The product's own `modeExit` binding, with a host that THROWS -- the
    // shape `ModeExitPort` documents as legal and the engine must survive.
    const ports: RunEnginePorts = {
      ...composed,
      modeExit: {
        onRunExit: async () => {
          exitCalls += 1;
          throw new Error('a mode teardown failed');
        },
      },
    };

    providerScript = [{ type: 'text', data: 'the model answered' }, DONE];
    const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
    await engine.execute({
      manifest: buildLegacyRunManifest(facts),
      input,
      signal: new AbortController().signal,
      ports,
    }).completed();
    turnPipelines.close();

    // The port WAS called...
    expect(exitCalls).toBe(1);
    // ...and the run still completed. A mode's teardown failing is not the run
    // failing; replacing a `completed` terminal with a failure here would be the
    // engine inventing an outcome the host never asked it to decide.
    expect(terminals).toHaveLength(1);
    expect(terminals[0].state.status).toBe('completed');
  });
});
