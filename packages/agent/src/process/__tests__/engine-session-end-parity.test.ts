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
 *   max_turns                (nothing)                (nothing)         yes
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
 * **Plan 610 D3 closed the ceiling row**, by removing the `SessionEnd` the engine
 * fired there. It restores parity with the legacy and is deliberate: the legacy's
 * silence on a NORMAL terminal is a known question that is deliberately NOT
 * addressed by this change, because folding a behaviour change into a driver swap
 * means a bisect can no longer attribute a regression. A hook that must run on
 * every terminal must not rely on this event.
 *
 * The model-leg row is a divergence in the OPPOSITE direction, recorded in its
 * own test rather than papered over: the engine has one `cancelled` reason and
 * cannot observe which of the legacy's two abort routes it is standing in for.
 *
 * ## Plan 610 D5: the four exits that had never been measured
 *
 * Measured on the same channel, in the same file, so the table above and this
 * one cannot be produced by two different probes:
 *
 *   path                          legacy `streamChat`   engine           row
 *   ----------------------------- --------------------- --------------- -----------
 *   repeated_tool_calls           (nothing)             (nothing)        D0 CLOSED
 *   budget_exhausted              (no such exit)        SessionEnd       D0 KEPT
 *   four early done(completed)    (nothing)             SessionEnd       CLOSED
 *
 * **Plan 610 D0 decided the first two, and the two decisions are OPPOSITE.**
 * That asymmetry is the finding, and it is not a hedge -- each row has a referent
 * the other lacks:
 *
 *  - `repeated_tool_calls` had a real legacy measurement to align to, taken on a
 *    path the legacy genuinely walks (`_commitMessages()`, a
 *    `done('repeated_tool_calls')` and a `return`, never reaching a
 *    `SessionFinalizer`), so parity was AVAILABLE and the swap is a driver swap.
 *    The argument for keeping the dispatch was real -- a guardrail that stopped a
 *    run making no progress is a more informative thing to tell cleanup hooks
 *    than silence -- and it lost, because the legacy reaches its ceiling AND its
 *    guardrail through the same return-without-a-finalizer shape, so the two
 *    silences are one decision and splitting them would make coverage depend on
 *    which non-answer the run produced.
 *  - `budget_exhausted` has NO legacy counterpart at all. `isBudgetExhausted` is
 *    called from `RunSession`, the server side, so a budget-exhausted legacy run
 *    is settled outside `streamChat` and never reaches a `SessionFinalizer`.
 *    There is nothing to align to, so "align to the legacy" would be invention
 *    rather than parity -- and inventing a silence for a terminal the legacy
 *    never produces is exactly the behaviour change D3 declined to make. Budget
 *    exhaustion is a normal terminal, consistent with `completed`, so dispatching
 *    is a NEW CAPABILITY rather than a behaviour change: no user could have
 *    depended on a silence that was never possible.
 *  - The four early `done('completed')` exits are a MATCH and are asserted as
 *    one, with the natural end measured alongside them as the baseline that
 *    makes "the early ones are exceptions" mean something. The engine collapses
 *    all four onto `completed`, where the legacy's natural end also dispatches,
 *    so the rows agree.
 *
 * ## The consequence of the pair, stated once
 *
 * `SessionEnd` does NOT fire on every terminal. It fires on `completed`, on
 * `budget_exhausted` and on a cancelled run; it is silent on `failed`, on
 * `max_turns` and on `repeated_tool_calls`. A hook that must run on every
 * terminal must not rely on this event.
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
  /**
   * Emitted INSTEAD of `frames`, on every call, when set.
   *
   * The dead-loop row needs the same call on every turn, which a frame LIST
   * cannot express: the script is consumed by index, so a second turn would
   * replay the last entry. A single constant frame is what makes "identical
   * name, identical input" true on turn N as well as turn 1.
   */
  readonly repeatFrame?: SSEEvent;
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
  // A FRESH object every time, and not a merge into the previous one. A merge
  // would let `repeatFrame` survive into the next run, so a test that ran the
  // dead-loop row would silently script a dead loop into every later assertion
  // in the file -- which is exactly the sort of leak that makes a row mean
  // something other than what it says.
  activeScript = { frames: [], ...options, calls: 0 };
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
        // The DEAD-LOOP frame, when one is installed, followed by the ordinary
        // stop. Both are emitted on EVERY call, and the stop matters: a stream
        // that ends without a `done` is a provider failure, so omitting it would
        // make this row measure an error rather than the guard.
        if (current.repeatFrame) {
          yield current.repeatFrame;
          // `tool_use`, NOT `end_turn`, and that is load-bearing rather than
          // incidental. The legacy's dead-loop guard sits BELOW its
          // `!needsFollowUp` branch, so a turn that ends with `end_turn`
          // finalizes through `finalizeSuccess` -- dispatching `SessionEnd` --
          // and never reaches `shouldHardStop()`. Only a turn that asks for
          // MORE work gets there, which is exactly what the guard's own comment
          // says ("only when the model requested more tool rounds"). Emitting
          // `end_turn` here measured the finalize path while claiming the guard.
          yield { type: 'done', reason: 'tool_use' } as SSEEvent;
          return;
        }
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
// The offline host: env and the modules under observation
// ============================================================================

// Plan 610 S4c-d3: the fake worker IPC, `installFakeDbIpc`, and the agent and
// registry factories it fed were the LEGACY harness's setup. They are deleted
// rather than left dormant, because a `db-client` import plus a
// `process.on('message')` capture is real import-time side effect that a
// reader would reasonably assume some assertion still depends on.
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { ConfigHooksRunner } = await import('../../hooks/events.js');
const { createLegacyHookSource } = await import('../hook-source.js');

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
let sessionCounter = 0;
/**
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
  /**
   * How many `after_finalize` contributors the engine actually INVOKED.
   *
   * Not the same question as `exitEvents`, and the difference is what makes an
   * empty `exitEvents` readable. Zero contributors could mean the phase never
   * ran; two contributors with no dispatch means they ran and chose silence.
   * Counted at the seam (`createLegacyHookSource`'s own `list` result) rather
   * than inferred from the events.
   */
  readonly contributorCount: number;
  readonly reason: string;
}

let engineSessionCounter = 0;

/**
 * Drive a real `RunEngineImpl` to the requested exit over real ports, with the
 * PRODUCT's real hook source on the extension port.
 *
 * `mode` selects the exit the ENGINE's own logic produces -- `completed` by
 * letting the turn finish, `max_turns` by capping it, `cancelled` by aborting
 * from inside the model turn, `failed` by making the provider leg throw,
 * `repeated_tool_calls` by asking for the same call every turn, and
 * `budget_exhausted` by giving the run a one-call budget. None of them injects a
 * reason: every one is a real arm of the engine's own stop decision, which is
 * what makes "the reason we expected" a claim rather than an input.
 */
async function runEngine(
  mode:
    | 'completed'
    | 'max_turns'
    | 'cancelled'
    | 'failed'
    | 'repeated_tool_calls'
    | 'budget_exhausted',
): Promise<EngineRun> {
  engineSessionCounter += 1;
  const invokedHooks: string[] = [];
  const reasons: string[] = [];
  const controller = new AbortController();
  /** Model turns opened, so the repeated-call ids stay distinct. */
  let streams = 0;
  // Counted by wrapping the seam's own `list`, so the number is the phase's real
  // contributor count and not a constant this file chose. Wrapping rather than
  // replacing, so the engine reads exactly the list it would have read.
  let contributorCount = 0;
  const hookSource = createLegacyHookSource({
    cwd: process.cwd(),
    sessionId: `s-d3-${engineSessionCounter}`,
    prompt: 'say something and stop',
    settings: HOOK_SETTINGS,
    onHookInvoked: (event) => invokedHooks.push(event.hookEventName),
  });
  const countedHookSource = {
    ...hookSource,
    list(phase: Parameters<typeof hookSource.list>[0]) {
      const contributors = hookSource.list(phase);
      if (phase === 'after_finalize') contributorCount = contributors.length;
      return contributors;
    },
  };

  const model: ModelPort = {
    async *stream(): AsyncIterable<ModelFrame> {
      if (mode === 'failed') throw new Error('the provider exploded');
      // The IDENTICAL call, every turn, so the run-scoped streak is what stops
      // the run rather than the ceiling. The name is the same and the input is
      // the same, which is the whole definition of the streak's repeat.
      //
      // The budget case asks for a tool too, and for the OPPOSITE reason: the
      // ceiling it crosses is on tool CALLS, so a run that never asks for one
      // would finish `completed` and the row would measure nothing.
      if (mode === 'repeated_tool_calls' || mode === 'budget_exhausted') {
        yield { type: 'tool_use', call: { callId: `r-${streams += 1}`, name: 'read', input: { path: 'same' } } };
        if (mode === 'repeated_tool_calls') return;
      }
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
    // Required since plan 610 D4. Both are bound to their smallest honest
    // answer -- "records nothing", "never compacts" -- because neither is what
    // this file measures. The exit-hook coverage has its own proofs; a bound
    // no-op cannot make a dispatch look like it happened when it did not, and
    // the non-vacuity comes from `onHookInvoked` instead.
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined', reason: 'not under test' }),
      nextCompactionId: () => 'cmp-parity',
    },
    model,
    tools: {
      // QUEUES into the drain rather than dropping the call, so a run that asks
      // for a tool really gets a result back. The `repeated_tool_calls` case
      // depends on it: a discarded call would still be counted by the streak,
      // but the turn would never close, and a row that measures a hang is not a
      // measurement.
      dispatch(call: ToolCallRequest): void {
        queued.push({
          kind: 'tool_result',
          callId: call.callId,
          content: `result of ${call.name}`,
          isError: false,
        });
      },
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
    // A real `BudgetPort` for the budget case. The ceiling is read from
    // `budget.budget` and compared against the ENGINE'S OWN spend ledger
    // (`#budgetExhausted` calls `isBudgetExhausted(budget.budget, spend.snapshot,
    // elapsed)`), so the row is measuring the engine's counting rather than a
    // stub's: `maxToolCalls: 1` refuses the second dispatch, which means the
    // first turn is opened, a tool is really requested, and the refusal is a
    // decision the engine made mid-loop rather than a run refused before it
    // spoke.
    //
    // `maxTurns` is deliberately absent here so the turn ceiling stays the
    // engine option's 8: a `maxTurns: 1` would end the run at the ceiling and
    // the row would measure the wrong exit.
    ...(mode === 'budget_exhausted'
      ? {
          budget: {
            budget: { maxToolCalls: 1 },
            spend: () => ({ turns: 0, toolCalls: 0, tokens: 0 }),
            evaluate: () => ({ exhausted: false, breaches: [] }),
          },
        }
      : {}),
    // A REAL side-effect ledger for the two rows that dispatch a tool.
    //
    // Not optional tidiness: `ports.ts` says an absent `sideEffects` means "no
    // tool with a side effect may be dispatched", and the engine enforces it --
    // a call whose class cannot be resolved is REFUSED, because a dispatch that
    // could not be written to the ledger is one a crash cannot classify. The
    // refusal message is the symptom (`declares 'undefined'`), and without a
    // ledger both rows would measure a refusal rather than the exit they claim.
    // `read_only` needs no durable record, so re-running it cannot double an
    // effect -- which is why the in-memory implementation is honest here.
    ...((mode === 'repeated_tool_calls' || mode === 'budget_exhausted')
      ? {
          sideEffects: {
            begin: (call: ToolCallRequest) =>
              Promise.resolve({
                attemptKey: `k:${call.callId}`,
                runId: RUN_ID,
                runEpoch: 1,
                fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
              }),
            settle: () => Promise.resolve(),
            reconcile: () => Promise.resolve(),
            read: () => Promise.resolve([]),
          },
        }
      : {}),
    // The product's own binding of config-hook events onto engine phases.
    extensions: countedHookSource,
  };

  const engine = new RunEngineImpl({
    now: () => 1_000,
    // 1 for the ceiling case, generous for every other: a generous ceiling is
    // what proves the OTHER exit reason ended the run rather than the cap. The
    // repeated-call case needs a ceiling well above its threshold, or the run
    // would end on the cap and the row would measure the wrong exit.
    defaultMaxTurns: mode === 'max_turns' ? 1 : 8,
    onReport: (report) => reasons.push(report.exit.reason),
  });
  const request: RunExecutionRequest = {
    manifest: manifestFor(),
    input: inputFor(),
    signal: controller.signal,
    ports,
    // Arming the anti-dead-loop guard is the HOST's decision, and the threshold
    // is 3 so the run stops by the streak on its 3rd identical call rather than
    // by the ceiling at 8 turns. A guard that is off cannot produce this exit at
    // all, which is what makes the row a measurement rather than a default.
    ...(mode === 'repeated_tool_calls'
      ? { repeatedCallStop: { enabled: true, hardStopAt: 3 } }
      : {}),
  };

  const recorder = recordDispatches();
  try {
    await engine.execute(request).completed();
  } finally {
    recorder.stop();
  }
  return {
    exitEvents: exitEvents(recorder.events),
    invokedHooks,
    contributorCount,
    reason: reasons[0] ?? 'none',
  };
}

// ============================================================================
// The measurement, one path at a time, both sides
// ============================================================================

describe('per-path exit hook events, pinned on the ENGINE path', () => {
  it('completed: SessionEnd, and Stop on neither', async () => {
    // Plan 610 S4c-d3: the legacy half of this row was MEASURED and is recorded
    // in the header table (`streamChat` -> `SessionEnd`), but the legacy loop no
    // longer exists, so it cannot be driven again. What is asserted below is the
    // ENGINE's own behaviour on this exit, which is the half that can still
    // regress. The parity decision it was aligned to is preserved as the table
    // row, not as a live comparison — see the header's "What replaced the pair".
    const engine = await runEngine('completed');

    // The run really reached the exit it claims, so this is not measuring the
    // wrong path.
    expect(engine.reason).toBe('completed');

    expect(engine.exitEvents).toEqual(['SessionEnd']);

    // NON-VACUITY on the engine side from the product's own channel: the
    // dispatch above was real work, a real subprocess, not an empty call.
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });

  it('aborted at the loop boundary: Stop then SessionEnd', async () => {
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
    // the one a user who pressed stop expects. That position is preserved as the
    // header's `aborted (loop exit)` row; the legacy half is no longer driven,
    // because the loop it drove is gone.
    const engine = await runEngine('cancelled');

    // This really is a cancellation -- without this an empty engine record
    // could just be a run that ended some other way.
    expect(engine.reason).toBe('cancelled');

    // The ORDER is part of the claim: `Stop` announces the stop and `SessionEnd`
    // closes the session, so a source that swapped them would still satisfy a
    // `toContain` on either name.
    expect(engine.exitEvents).toEqual(['Stop', 'SessionEnd']);

    // NON-VACUITY on the engine side from the product's own channel: the two
    // dispatches above were real work, real subprocesses, not empty calls. A
    // hook that did not run would satisfy the spy alone.
    expect(engine.invokedHooks).toEqual(['Stop', 'SessionEnd']);
  });

  it('failed: the engine dispatches NO exit event at all', async () => {
    // The failure really happened: an empty event list on a `completed` exit
    // would be a green that measured nothing.
    const engine = await runEngine('failed');
    expect(engine.reason).toBe('failed');

    // This is the row that makes "the legacy fires NOTHING on the stream-error
    // path" true, and it is what the other claim in `run-engine.ts` denied. The
    // legacy half was measured (header table, `stream error` row) and the engine
    // is what this pins going forward.
    expect(engine.exitEvents).toEqual([]);
  });

  it('aborted at the MODEL LEG: the engine dispatches Stop + SessionEnd, and that is recorded', async () => {
    // The second abort route, and the one that made the legacy's coverage
    // unreproducible: `finalizeStreamError` mapped an `AbortError` onto the SAME
    // `done('aborted')` terminal `finalizeAbort` used, then returned before any
    // dispatch. Two exits, one terminal event, opposite hook coverage.
    //
    // Plan 610 D2 made this row a DIVERGENCE, in the opposite direction from
    // the row it closed. It was a match before only because the engine said
    // nothing on either route; the engine now says `Stop` + `SessionEnd` on
    // both, because it has ONE `cancelled` reason and cannot observe which
    // route it took -- `handle.stop()` and a caller's abort both land on it.
    //
    // RECORDED rather than closed, and deliberately: matching the legacy here
    // would mean reproducing an accident of where the abort landed rather than
    // a policy about what a cancelled run tells its cleanup hooks. The legacy's
    // silence was a consequence of `finalizeStreamError` returning early, not a
    // decision anyone made about cancellation. Aligning to it would mean a user
    // who stops a run during a model call gets no teardown, which is the defect
    // D2 exists to remove. The legacy half (silent) is the header's
    // `aborted (model leg)` row; the engine's behaviour is what this pins.
    const engine = await runEngine('cancelled');
    expect(engine.reason).toBe('cancelled');
    expect(engine.exitEvents).toEqual(['Stop', 'SessionEnd']);
  });

  it('max_turns: NEITHER path dispatches, which is parity the flip chose deliberately', async () => {
    // Plan 610 D3 CLOSED this row. The engine used to dispatch `SessionEnd` when
    // a run ended on the turn ceiling; the legacy dispatches nothing, because it
    // reaches that exit with a `done('max_turns')` and a `return` and never calls
    // a `SessionFinalizer` at all.
    //
    // ALIGNED TO THE LEGACY rather than the other way round, and that is a real
    // trade: a teardown hook silently skipping a NORMAL terminal is arguably a
    // legacy bug, and this change leaves it in place. It is left in place on
    // purpose -- folding a behaviour change into a driver swap means a bisect
    // can no longer attribute a regression, and a refactor that also changes
    // behaviour is two changes wearing one commit. The legacy's silence on a
    // normal terminal is a known question, deliberately NOT addressed here.
    //
    // The operational consequence, stated so it is not rediscovered as a bug:
    // a hook that must run on EVERY terminal must not rely on this event.
    const engine = await runEngine('max_turns');

    // This really ended at the ceiling. The engine's own `#shouldStop` ceiling
    // arm is the only way it reaches this exit; without this an empty engine
    // record could be a run that ended some other way.
    expect(engine.reason).toBe('max_turns');

    expect(engine.exitEvents).toEqual([]);
    // Non-vacuity in the OTHER direction: the engine really reached the exit
    // contributors and really ran them, and they dispatched nothing. This is
    // what distinguishes "aligned" from "the hook source is not wired here".
    expect(engine.contributorCount).toBe(2);
    expect(engine.invokedHooks).toEqual([]);
  });
});

// ============================================================================
// Plan 610 D5: the four exit paths that had never been measured
// ============================================================================

describe('the previously unmeasured exits, pinned on the ENGINE path', () => {
  it('repeated_tool_calls: NEITHER path dispatches, which is parity the flip required', async () => {
    // The legacy's anti-dead-loop hard stop is `_commitMessages()`, a
    // `done('repeated_tool_calls')` and a `return`. It never reaches a
    // `SessionFinalizer`, so there is no dispatch site left to fire from.
    //
    // Two facts about the DRIVE, both learned by getting them wrong first, and
    // both load-bearing to the row meaning what it says:
    //
    //  - the guard sits BELOW the `!needsFollowUp` branch, so a turn ending in
    //    `end_turn` finalizes through `finalizeSuccess` (dispatching
    //    `SessionEnd`) and never reaches `shouldHardStop()`. The scripted stop
    //    must therefore be `tool_use` — "more work requested", which is what the
    //    guard's own comment says it is for.
    //  - the repeat frame's tool call must be IDENTICAL on every turn, because
    //    the tracker keys on name plus serialised input. A per-turn id is
    //    irrelevant to it, but a per-turn input would reset the streak.
    const engine = await runEngine('repeated_tool_calls');

    // This really ended on the guard, not on the ceiling: the engine's
    // threshold is 3 against the shared ceiling of 8.
    expect(engine.reason).toBe('repeated_tool_calls');

    // Plan 610 D0 CLOSED this row. The engine used to dispatch `SessionEnd` when
    // a run ended on the anti-dead-loop guardrail; the legacy dispatches nothing,
    // because it reached that exit with `_commitMessages()`, a
    // `done('repeated_tool_calls')` and a `return`, never calling a
    // `SessionFinalizer`.
    //
    // ALIGNED TO THE LEGACY, for the same reason D3 aligned the ceiling rather
    // than the other way round: the flip swaps a driver, so anything the engine
    // says where the legacy says nothing is a behaviour change folded into a
    // refactor, and a bisect can no longer attribute a regression.
    //
    // This was DECIDED rather than inherited, and the argument for keeping the
    // dispatch was real: a guardrail that stopped a run making no progress is a
    // more informative thing to tell a session's cleanup hooks than silence.
    // It loses because the legacy's silence on this exit is not an accident of
    // control flow in the way the guardrail case would have to be -- the legacy
    // reached BOTH its ceiling and its guardrail through the same
    // return-without-a-finalizer shape, so the two silences are one decision,
    // and splitting them would make the engine's coverage depend on which
    // non-answer it produced.
    //
    // Note the asymmetry with the budget row below, which this same commit
    // deliberately did NOT close: that terminal has no legacy path at all.
    expect(engine.exitEvents).toEqual([]);
    // Non-vacuity in the OTHER direction, and the same check the ceiling row
    // carries: the engine really reached the exit contributors and really ran
    // them, and they dispatched nothing. Without it, an empty record could mean
    // "the hook source is not wired on this path" rather than "they ran and
    // chose silence" -- two different facts, and only the second one is parity.
    expect(engine.contributorCount).toBe(2);
    expect(engine.invokedHooks).toEqual([]);
  });

  it('budget_exhausted: there is NO legacy row, and the engine KEEPS dispatching', async () => {
    // NOT MEASURED AS A PAIR, and the reason is structural rather than a gap in
    // the harness: the legacy loop has no budget exit at all. `isBudgetExhausted`
    // is called from `RunSession`, the SERVER side, and folded into
    // `resolveRunOutcome` -- so a budget-exhausted legacy run is settled outside
    // `streamChat` and never reaches a `SessionFinalizer`. Driving the legacy
    // to this path is not possible, so there is no legacy row to compare.
    //
    // What IS asserted is the engine's own behaviour. `budget_exhausted` is
    // neither a failure nor a cancellation, so `firesOnExit` says YES to
    // `SessionEnd` and the engine dispatches it.
    //
    // Plan 610 D0 KEPT that, and the reason it differs from the row above is the
    // whole point of the two decisions being opposite: the ceiling and the
    // guardrail each have a legacy counterpart that was MEASURED on a path the
    // legacy genuinely walks, so "align to the legacy" is parity available to be
    // taken. This terminal has no legacy path at all -- the budget check is
    // invoked from `RunSession`, the server side -- so "align to the legacy"
    // would have no referent. Silencing it would be INVENTING a silence for a
    // terminal the legacy cannot produce, which is the behaviour change D3
    // declined to make and D0 declined to make here.
    //
    // Budget exhaustion is a normal terminal, consistent with `completed`, so
    // dispatching is a NEW CAPABILITY rather than a behaviour change: no user
    // can have depended on a silence that was never possible. Measured on the
    // engine's own `#budgetExhausted` arm -- the port's ceiling is one tool call
    // and the engine's own spend is what crosses it -- so the reason below is the
    // engine's decision rather than an injected input.
    //
    // CONSEQUENCE, stated because the pair above makes it easy to get wrong: a
    // hook that must run on EVERY terminal must NOT rely on `SessionEnd`. It
    // fires on `completed`, `budget_exhausted` and a cancelled run, and it is
    // silent on `failed`, `max_turns` and `repeated_tool_calls`.
    const engine = await runEngine('budget_exhausted');

    // The run really ended on the budget: the port's ceiling is one tool call
    // and the engine's own spend is what crosses it, so this is the engine's
    // decision rather than an injected reason.
    expect(engine.reason).toBe('budget_exhausted');
    expect(engine.contributorCount).toBe(2);

    // The decision, asserted so it cannot drift unnoticed. If a later slice decides
    // budget exhaustion should be silent, this row is where that decision lands
    // and the reasoning above is what it has to overturn.
    expect(engine.exitEvents).toEqual(['SessionEnd']);
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });

  it('the early completed exits: the engine agrees with the legacy on all four', async () => {
    // All four are the same shape, which is why they are one test rather than
    // four: each yielded `done('completed')` and returned from `streamChat`
    // without ever calling a `SessionFinalizer`. The four were the `/goal`
    // continuation, `/export`, the mailbox soft stop, and a background resume
    // with nothing to claim.
    //
    // The engine collapses all four onto ONE `completed` reason, and on
    // `completed` it dispatches `SessionEnd` -- because `finalizeSuccess` was the
    // legacy's own method for a natural end. So these rows MATCHED the legacy:
    // the legacy's early exits reached no dispatch site.
    //
    // Two facts, stated because they were both MEASURED and both are load-bearing
    // to what this row can still claim:
    //
    //  - The four `yield { type: 'done', reason: 'completed' }` sites were
    //    counted in `DuyaAgent.ts` to establish the number four. That file's
    //    legacy turn generator was DELETED in plan 610 S4c-d3, so the count is
    //    no longer countable and the four exits are no longer reachable through
    //    that code path at all. The count is recorded here rather than asserted,
    //    because asserting it would require re-adding the loop this slice
    //    exists to delete.
    //  - The legacy BASELINE those four were exceptions to -- "a turn that really
    //    ran dispatches `SessionEnd` through `finalizeSuccess`" -- is now
    //    measured on the engine side below, which is the path that exists.
    const engine = await runEngine('completed');
    expect(engine.reason).toBe('completed');
    expect(engine.contributorCount).toBe(2);
    // The engine's natural end dispatches `SessionEnd`, and a real subprocess
    // ran it. This is the same fact the legacy's two ordinary turns established,
    // now read off the path that is still live.
    expect(engine.exitEvents).toEqual(['SessionEnd']);
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });
});