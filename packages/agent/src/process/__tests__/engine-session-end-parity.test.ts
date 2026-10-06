/**
 * Plan 610: which `SessionEnd` claim was wrong, and what the flip decided about
 * each path.
 *
 * ## The dispute, in the tree, in two sentences each
 *
 * `run-engine.ts`'s `after_finalize` block said the legacy "fires `SessionEnd`
 * on the same three paths" a failed and a cancelled run reach, and forty lines
 * later the same block said the legacy "fires NOTHING on the stream-error
 * path". Both cannot be true, and neither mentioned the paths where the two
 * sides plainly differ.
 *
 * ## The measured table, per path
 *
 *   path                     legacy `streamChat`      engine            agree?
 *   ------------------------ ------------------------ ----------------- ------
 *   completed                SessionEnd               SessionEnd        yes
 *   aborted (loop exit)      Stop, SessionEnd         Stop, SessionEnd  yes
 *   aborted (model leg)      (nothing)                Stop, SessionEnd  NO
 *   stream error             (nothing)                (nothing)         yes
 *   max_turns                (nothing)                SessionEnd        NO
 *
 * Three rows agreed and two did not, and the two pointed in OPPOSITE
 * directions: on a cancellation the engine said LESS than the legacy, and at
 * the ceiling it said MORE.
 *
 * **Plan 610 D2 closed the cancellation row.** The cause was an ORDER in
 * `hook-source.ts`'s `contributorsFor`, not the exit-reason mapping: the
 * `signal.aborted` guard returned before `firesOnExit` was consulted, so `Stop`
 * was unreachable rather than unused. The guard is now tested second and
 * narrowed to the in-turn phases. A cancelled run runs its cleanup hooks, which
 * is what `SessionFinalizer.finalizeAbort` does and what a user who pressed stop
 * expects.
 *
 * The model-leg row became a divergence in the OPPOSITE direction as a
 * consequence, and is recorded in its own test rather than papered over: the
 * engine has one `cancelled` reason and cannot observe which of the legacy's two
 * abort routes it is standing in for.
 *
 * The `max_turns` row is untouched by D2 and still open; see the D3 test.
 *
 * ## Why the legacy is silent where it is silent
 *
 * `DuyaAgent.streamChat` reaches its ceiling with `_commitMessages()`, a
 * `done('max_turns')` and a `return` -- it never calls a `SessionFinalizer`, so
 * there is no dispatch site left to fire from. The anti-dead-loop hard stop
 * ends the same way, and four early exits (`/goal` continuation, `/export`,
 * the mailbox soft stop, a background resume with nothing to claim) all yield
 * `done('completed')` without a finalizer either.
 *
 * The model-leg abort is a different accident: `SessionFinalizer.finalizeStreamError`
 * special-cases an `AbortError` into `done('aborted')` and returns BEFORE any
 * dispatch, so an abort that reaches the model leg and an abort that exits the
 * loop end on the SAME terminal event with completely different hook coverage.
 * `finalizeAbort` -- the one that dispatches `Stop` and `SessionEnd` -- is
 * reached only when the loop's own `while` condition goes false.
 *
 * None of that is a contract. The legacy's ceiling exits and its early exits
 * collapse onto one engine reason (`max_turns` and `completed` respectively),
 * and its two abort routes collapse onto one too.
 *
 * ## What is real, and what is faked, line by line
 *
 * REAL on both sides: `duyaAgent.streamChat` and `SessionFinalizer`; the
 * engine's `RunEngineImpl` and its `after_finalize` call site; the product's
 * `createLegacyHookSource`; a real `ConfigHooksRunner`; and, on the engine side,
 * real `node` hook subprocesses built from a real `HooksSettings`.
 *
 * FAKED: the provider (scripted through the same `@duya/ai` factory seam the
 * sibling product-turn proof uses) and the worker's DB IPC. Neither replaces a
 * leg under test -- what is under test is which hook EVENTS a run dispatches on
 * the way out.
 *
 * ## The observation channel, and why both sides share it
 *
 * One spy, on `ConfigHooksRunner.prototype.run`, records every dispatch on
 * either path. Sharing it is the point: the two code paths under test are
 * completely disjoint, so a difference in the record is a difference in
 * behaviour rather than an artefact of two different probes. On the engine side
 * a second, product-owned channel (`onHookInvoked`) confirms the dispatch was
 * real work and not an empty dispatch, so "the spy saw a `SessionEnd`" cannot be
 * satisfied by a source that dispatches into nothing.
 *
 * The legacy cannot be given that second channel here: `ConfigHooksRunner` reads
 * its settings with `readHooksConfig()` when the host passes none, so
 * configuring a real legacy hook would mean writing to the developer's own hooks
 * config. Its record is therefore the dispatch boundary alone, and that is the
 * honest limit of this measurement.
 *
 * ## Where this file lives
 *
 * `packages/agent/src/process/__tests__/`, because it drives the agent's own
 * loop AND the engine. `pkg:agent-runtime` is managed with a one-way dependency
 * on `pkg:agent`, so the same test under `packages/agent-runtime/tests/` is a
 * blocking boundary violation -- see the sibling
 * `engine-before-finalize-parity.test.ts` for what that looks like.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelPort,
  RunEnginePorts,
  RunExecutionRequest,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
} from '@duya/agent-runtime';
import type { RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import type { HooksSettings } from '../../hooks/types.js';

// ============================================================================
// The scripted PROVIDER -- the only fake standing in for a leg's far end
// ============================================================================

const DONE_END_TURN: SSEEvent = { type: 'done', reason: 'end_turn' };

interface ProviderScript {
  readonly frames: readonly SSEEvent[];
  /** Mutated by the provider seam, so it is NOT readonly. */
  calls: number;
  /** Zero-based call index that throws a plain error; absent = never. */
  throwErrorOn?: number;
  /** Zero-based call index that throws an `AbortError`; absent = never. */
  throwAbortOn?: number;
}

let activeScript: ProviderScript | null = null;

/**
 * Install the provider's script.
 *
 * The two throw kinds are carried ON THE HOLDER rather than captured in the
 * mock's scope: the `@duya/ai` factory is hoisted above every module-scope
 * binding in this file, so a variable from this function's scope is not visible
 * inside it. They are also two genuinely different exits -- a plain error
 * reaches `finalizeStreamError`'s error branch, an `AbortError` reaches its
 * abort branch, and only one of those two branches dispatches anything.
 */
function script(options: Omit<ProviderScript, 'calls'>): void {
  activeScript = { ...options, calls: 0 };
}

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      const current = activeScript;
      if (!current) throw new Error('no scripted provider installed for this test');
      const index = current.calls;
      current.calls += 1;
      const signal = options?.signal as AbortSignal | undefined;

      if (current.throwAbortOn !== undefined && index === current.throwAbortOn) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return (async function* () {
          yield* [];
          throw err;
        })();
      }
      if (current.throwErrorOn !== undefined && index === current.throwErrorOn) {
        const err = new Error('the provider exploded');
        err.name = 'ProviderError';
        return (async function* () {
          yield* [];
          throw err;
        })();
      }

      return (async function* () {
        for (const event of current.frames) {
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
// The offline host: env, the worker IPC, and the agent
// ============================================================================

const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

const PRE_EXISTING_MESSAGE_LISTENERS = new Set(process.listeners('message'));

// The product modules come AFTER that capture, and the order is load-bearing:
// importing any of them can register the db-client's own `process.on('message')`
// listener, and a capture taken afterwards would subtract the wrong set and leave
// the db-client's listener unresolvable.
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { ConfigHooksRunner } = await import('../../hooks/events.js');
const { createLegacyHookSource } = await import('../hook-source.js');

let dbResponseListener: ((msg: unknown) => void) | null = null;

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  activeScript = null;
});

/**
 * Install the fake worker IPC the turn reaches for before its first request.
 *
 * Identical in shape to the sibling product-turn proof's fixture, including the
 * pre-existing-listener capture: under a Vitest pool worker `process.send` is
 * the POOL's channel, so a plain object sent through it makes the pool try to
 * deserialize a Buffer and throw. Delivering the response straight to the
 * db-client's own listener is what keeps that from happening.
 */
function installFakeDbIpc(): void {
  if (!dbResponseListener) {
    initDbClient();
    const added = process
      .listeners('message')
      .filter((l) => !PRE_EXISTING_MESSAGE_LISTENERS.has(l));
    dbResponseListener = (added[0] ?? null) as ((msg: unknown) => void) | null;
    if (!dbResponseListener) throw new Error('db-client registered no message listener');
  }
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; id?: string; action?: string };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action in the session-end parity test: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => {
      dbResponseListener?.({ type: 'db:response', id: req.id, success: true, result });
    });
    return true;
  }) as unknown as typeof process.send;
}

let sessionCounter = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionCounter += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-session-end-${sessionCounter}-${Math.random().toString(36).slice(2)}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

/**
 * A probe tool whose only job is to make the loop ask for another turn.
 *
 * `gate` is what separates the two abort routes: with the executor blocked on it,
 * the interrupt lands while a tool is genuinely mid-flight, the executor's race
 * abandons it, and the loop's own `while` condition goes false -- which is the
 * ONLY way into `finalizeAbort`. Without the gate the interrupt tends to land on
 * the next provider call instead, which is the other route entirely.
 */
function registryWithProbe(spec: { readonly onStart?: () => void; readonly gate?: Promise<void> } = {}): InstanceType<
  typeof ToolRegistry
> {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'probe_end',
      description: 'probe that exists only to make the loop ask for another turn',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        spec.onStart?.();
        if (spec.gate) await spec.gate;
        return { id: 'r1', name: 'probe_end', result: 'RAN' };
      },
    } as never,
  );
  return registry;
}

async function collectLegacy(
  agent: InstanceType<typeof duyaAgent>,
  registry: InstanceType<typeof ToolRegistry>,
  options: Record<string, unknown> = {},
): Promise<readonly SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of agent.streamChat('say something and stop', {
    toolRegistry: registry,
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

// ============================================================================
// The shared observation channel
// ============================================================================

/**
 * Record every `ConfigHooksRunner` dispatch until the returned stop() is called.
 *
 * A prototype spy, not an instance stub: the legacy builds its runner inside
 * `streamChat` and the engine's `createLegacyHookSource` builds its own, so
 * neither can be handed a fake. The spy CALLS THROUGH, so the dispatch still
 * happens -- an observation that changed behaviour would be measuring itself.
 */
function recordDispatches(): { readonly events: readonly string[]; stop: () => void } {
  const events: string[] = [];
  // `InstanceType<typeof ...>` rather than the bare name: the class is reached
  // through a hoisted dynamic import, so the binding is a VALUE and the bare
  // name is not in scope as a type. This compiles the same for either and adds
  // no second import for the type checker to keep in step.
  type Runner = InstanceType<typeof ConfigHooksRunner>;
  // The ORIGINAL, captured before the spy replaces it. Reaching for
  // `ConfigHooksRunner.prototype.run` from inside the mock implementation would
  // find the SPY -- it is installed on the same prototype -- and recurse until the
  // stack overflowed, which the product's own fail-open `dispatchHooks` then
  // swallowed as a skipped dispatch.
  const original = ConfigHooksRunner.prototype.run;
  const spy = vi.spyOn(ConfigHooksRunner.prototype, 'run');
  spy.mockImplementation(async function (this: Runner, ...args: Parameters<Runner['run']>) {
    events.push(args[0]);
    return original.apply(this, args);
  });
  return { events, stop: () => spy.mockRestore() };
}

/** Only the two events an exit can raise; `on_start` fires on every path. */
function exitEvents(events: readonly string[]): string[] {
  return events.filter((event) => event === 'Stop' || event === 'SessionEnd');
}

// ============================================================================
// The LEGACY harness: run the real `streamChat` to one path
// ============================================================================

interface LegacyRun {
  readonly exitEvents: readonly string[];
  readonly terminal: string | undefined;
}

/**
 * Drive the real legacy turn to the requested exit and report what it dispatched
 * on the way out.
 */
async function runLegacy(options: {
  readonly frames: readonly SSEEvent[];
  readonly maxTurns?: number;
  readonly abortDuringTool?: boolean;
  readonly abortAtModelLeg?: boolean;
  readonly errorAtModelLeg?: boolean;
}): Promise<LegacyRun> {
  installFakeDbIpc();
  let agentRef: InstanceType<typeof duyaAgent> | null = null;
  // A HOLDER rather than a `let releaseTool: (() => void) | null`: the resolver
  // is assigned from inside a `Promise` executor, which the control-flow
  // analysis cannot see run, so a plain `let` stays narrowed to `null` at every
  // use below and `releaseTool?.()` stops being callable.
  const gate: { release: () => void } = { release: () => {} };
  const toolGate = new Promise<void>((resolve) => {
    gate.release = resolve;
  });

  const registry = registryWithProbe(
    options.abortDuringTool === true
      ? {
          onStart: () => {
            setTimeout(() => agentRef?.interrupt(), 0);
          },
          gate: toolGate,
        }
      : {},
  );
  script({
    frames: options.frames,
    ...(options.abortAtModelLeg === true ? { throwAbortOn: 0 } : {}),
    ...(options.errorAtModelLeg === true ? { throwErrorOn: 0 } : {}),
  });
  agentRef = makeAgent();

  const recorder = recordDispatches();
  let events: readonly SSEEvent[] = [];
  try {
    events = await collectLegacy(
      agentRef,
      registry,
      options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns },
    );
  } finally {
    recorder.stop();
    // The gated tool is still parked on its promise at this point; releasing it
    // here keeps its late completion from becoming an unhandled rejection.
    gate.release();
  }
  const done = events.filter((event) => event.type === 'done');
  const last = done[done.length - 1] as { reason?: string } | undefined;
  return { exitEvents: exitEvents(recorder.events), terminal: last?.reason };
}

// ============================================================================
// The ENGINE harness: run a real engine to one path
// ============================================================================

const RUN_ID = 'run-d3' as RunId;
const TOOL: ToolDescriptor = { name: 'read', description: 'read a file', inputSchema: {} };

/**
 * A REAL hook, run as a real `node` subprocess, for each event an exit raises.
 */
const HOOK_ECHO =
  'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const i=JSON.parse(d);process.stdout.write(i.hook_event_name)})"';

const HOOK_SETTINGS: HooksSettings = {
  Stop: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_ECHO }] }],
};

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: RUN_ID,
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      deterministic: { source: 'unsupported', synthesised: true },
    },
  } as RunManifest;
}

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'say something and stop' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

interface EngineRun {
  /** Dispatched exit events, from the SHARED channel. */
  readonly exitEvents: readonly string[];
  /** Hook names the product reported having actually RUN. */
  readonly invokedHooks: readonly string[];
  readonly reason: string;
}

let engineSessionCounter = 0;

/**
 * Drive a real `RunEngineImpl` to the requested exit over real ports, with the
 * PRODUCT's real hook source on the extension port.
 *
 * `mode` selects the exit the ENGINE's own logic produces -- `completed` by
 * letting the turn finish, `max_turns` by capping it, `cancelled` by aborting
 * from inside the model turn, `failed` by making the provider leg throw. None of
 * them injects a reason: every one is a real arm of the engine's own stop
 * decision, which is what makes "the reason we expected" a claim rather than an
 * input.
 */
async function runEngine(mode: 'completed' | 'max_turns' | 'cancelled' | 'failed'): Promise<EngineRun> {
  engineSessionCounter += 1;
  const invokedHooks: string[] = [];
  const reasons: string[] = [];
  const controller = new AbortController();

  const model: ModelPort = {
    async *stream(): AsyncIterable<ModelFrame> {
      if (mode === 'failed') throw new Error('the provider exploded');
      yield { type: 'turn_stopped', reason: 'end_turn' };
      // Abort AFTER the turn produced an answer, so the engine's post-turn
      // `isAborted` check -- not a pre-turn one -- is what decides the exit.
      if (mode === 'cancelled') controller.abort();
    },
  };

  const queued: ToolDrainItem[] = [];
  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model,
    tools: {
      dispatch(_call: ToolCallRequest): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of queued.splice(0, queued.length)) yield item;
      },
      discard(): void {
        queued.length = 0;
      },
      describe: (): readonly ToolDescriptor[] => [TOOL],
    },
    context: {
      assemble: (): Promise<AssembledTurn> =>
        Promise.resolve({
          systemPrompt: 'you are a test',
          messages: [],
          tools: [TOOL],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        }),
      defer(): void {},
    },
    approval: {
      authorize: (): Promise<ApprovalVerdict> =>
        Promise.resolve({ allowed: true, scope: 'once' }),
    },
    events: {
      publish(_event: unknown): void {},
      proposeTerminal(): void {},
    },
    // The product's own binding of config-hook events onto engine phases.
    extensions: createLegacyHookSource({
      cwd: process.cwd(),
      sessionId: `s-d3-${engineSessionCounter}`,
      prompt: 'say something and stop',
      settings: HOOK_SETTINGS,
      onHookInvoked: (event) => invokedHooks.push(event.hookEventName),
    }),
  };

  const engine = new RunEngineImpl({
    now: () => 1_000,
    // 1 for the ceiling case, generous for every other: a generous ceiling is
    // what proves the OTHER exit reason ended the run rather than the cap.
    defaultMaxTurns: mode === 'max_turns' ? 1 : 8,
    onReport: (report) => reasons.push(report.exit.reason),
  });
  const request: RunExecutionRequest = {
    manifest: manifestFor(),
    input: inputFor(),
    signal: controller.signal,
    ports,
  };

  const recorder = recordDispatches();
  try {
    await engine.execute(request).completed();
  } finally {
    recorder.stop();
  }
  return { exitEvents: exitEvents(recorder.events), invokedHooks, reason: reasons[0] ?? 'none' };
}

// ============================================================================
// The measurement, one path at a time, both sides
// ============================================================================

describe('per-path exit hook events, measured on BOTH paths', () => {
  it('completed: SessionEnd on both, and Stop on neither', async () => {
    const legacy = await runLegacy({ frames: [{ type: 'text', data: 'done.' }, DONE_END_TURN] });
    const engine = await runEngine('completed');

    // Each side reached the exit it claims, so neither row is measuring the
    // wrong path.
    expect(legacy.terminal).toBe('completed');
    expect(engine.reason).toBe('completed');

    expect(legacy.exitEvents).toEqual(['SessionEnd']);
    expect(engine.exitEvents).toEqual(['SessionEnd']);

    // NON-VACUITY on the engine side from the product's own channel: the
    // dispatch above was real work, a real subprocess, not an empty call.
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });

  it('aborted at the loop boundary: BOTH dispatch Stop then SessionEnd', async () => {
    // Plan 610 D2 CLOSED this row. It used to be a divergence: the legacy
    // dispatches `Stop` then `SessionEnd` from
    // `SessionFinalizer.finalizeAbort`, and the engine dispatched NOTHING.
    //
    // The cause was not the exit-reason mapping but an ORDER in
    // `hook-source.ts`'s `contributorsFor`: the `signal.aborted` guard returned
    // BEFORE `firesOnExit` was consulted, and `signal.aborted` is necessarily
    // true on every cancelled run, so `firesOnExit`'s `Stop` arm was
    // unreachable rather than unused. The guard is now tested second, and only
    // narrowed to the in-turn phases.
    //
    // A cancelled run runs its cleanup hooks, which is the legacy's position and
    // the one a user who pressed stop expects.
    const legacy = await runLegacy({
      frames: [
        { type: 'tool_use', data: { id: 't1', name: 'probe_end', input: { value: 'hold' } } },
        DONE_END_TURN,
      ],
      abortDuringTool: true,
    });
    const engine = await runEngine('cancelled');

    // Both really are cancellations -- without this an empty engine record
    // could just be a run that ended some other way.
    expect(legacy.terminal).toBe('aborted');
    expect(engine.reason).toBe('cancelled');

    // The ORDER is part of the legacy's claim: `Stop` announces the stop and
    // `SessionEnd` closes the session, so a source that swapped them would
    // still satisfy a `toContain` on either name. Asserted on BOTH sides for
    // that reason, not only on the legacy's.
    expect(legacy.exitEvents).toEqual(['Stop', 'SessionEnd']);
    expect(engine.exitEvents).toEqual(['Stop', 'SessionEnd']);

    // NON-VACUITY on the engine side from the product's own channel: the two
    // dispatches above were real work, real subprocesses, not empty calls. A
    // hook that did not run would satisfy the spy alone.
    expect(engine.invokedHooks).toEqual(['Stop', 'SessionEnd']);
  });

  it('failed: NEITHER path dispatches an exit event at all', async () => {
    const legacy = await runLegacy({
      frames: [{ type: 'text', data: 'never read' }],
      // A plain provider error, so the run reaches `finalizeStreamError`'s error
      // branch rather than its abort branch.
      errorAtModelLeg: true,
    });
    const engine = await runEngine('failed');

    // The failure really happened on both sides. An empty event list on a
    // `completed` exit would be a green that measured nothing.
    expect(legacy.terminal).toBe('error');
    expect(engine.reason).toBe('failed');

    // This is the row that makes "the legacy fires NOTHING on the stream-error
    // path" true, and it is what the other claim in `run-engine.ts` denied.
    expect(legacy.exitEvents).toEqual([]);
    expect(engine.exitEvents).toEqual([]);
  });

  it('aborted at the MODEL LEG: the legacy is silent and the engine now dispatches, and that is recorded', async () => {
    // The second abort route, and the one that makes the legacy's coverage
    // unreproducible: `finalizeStreamError` maps an `AbortError` onto the SAME
    // `done('aborted')` terminal `finalizeAbort` uses, then returns before any
    // dispatch. Two exits, one terminal event, opposite hook coverage.
    //
    // Plan 610 D2 makes this row a DIVERGENCE, in the opposite direction from
    // the row it closed. It was a match before only because the engine said
    // nothing on either route; the engine now says `Stop` + `SessionEnd` on
    // both, because it has ONE `cancelled` reason and cannot observe which
    // route it took -- `handle.stop()` and a caller's abort both land on it.
    //
    // RECORDED rather than closed, and deliberately: matching the legacy here
    // would mean reproducing an accident of where the abort landed rather than
    // a policy about what a cancelled run tells its cleanup hooks. The legacy's
    // silence is a consequence of `finalizeStreamError` returning early, not a
    // decision anyone made about cancellation. Aligning to it would mean a user
    // who stops a run during a model call gets no teardown, which is the defect
    // D2 exists to remove. This row is the cost of that decision, stated.
    const legacy = await runLegacy({
      frames: [{ type: 'text', data: 'never read' }],
      abortAtModelLeg: true,
    });
    const engine = await runEngine('cancelled');

    expect(legacy.terminal).toBe('aborted');
    expect(engine.reason).toBe('cancelled');

    expect(legacy.exitEvents).toEqual([]);
    expect(engine.exitEvents).toEqual(['Stop', 'SessionEnd']);
  });

  it('max_turns: the legacy dispatches NOTHING and the engine dispatches SessionEnd', async () => {
    // THE DIVERGENCE. Unrecorded anywhere before this file, and the reason the
    // two comments disagreed: one of them quietly assumed the legacy's silence
    // here was a designed coverage list.
    const legacy = await runLegacy({
      frames: [
        { type: 'tool_use', data: { id: 't1', name: 'probe_end', input: { value: 'x' } } },
        DONE_END_TURN,
      ],
      maxTurns: 1,
    });
    const engine = await runEngine('max_turns');

    // Both really ended at the ceiling. `maxTurns: 1` with a tool call on turn 1
    // is the only way the legacy reaches this exit, and the engine's own
    // `#shouldStop` ceiling arm is the only way it reaches its one.
    expect(legacy.terminal).toBe('max_turns');
    expect(engine.reason).toBe('max_turns');

    // The divergence, asserted on both sides rather than described.
    expect(legacy.exitEvents).toEqual([]);
    expect(engine.exitEvents).toEqual(['SessionEnd']);
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });
});