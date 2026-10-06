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
 *   repeated_tool_calls           (nothing)             SessionEnd       RECORDED
 *   budget_exhausted              (no such exit)        SessionEnd       RECORDED
 *   four early done(completed)    (nothing)             SessionEnd       CLOSED
 *
 * The first two are recorded rather than closed, and the reasons differ, which
 * is the finding:
 *
 *  - `repeated_tool_calls` is a real divergence with a real legacy measurement
 *    to align to, and it is the same shape D3 closed at the ceiling. It is NOT
 *    closed because it is a different case -- a guardrail that actively stopped a
 *    run making no progress, rather than a normal ending that ran out of turns
 *    -- so telling a session's cleanup hooks about it is arguably more true than
 *    telling them nothing. That is an argument, not a decision. The flip decides.
 *  - `budget_exhausted` has NO legacy counterpart at all. `isBudgetExhausted` is
 *    called from `RunSession`, the server side, so a budget-exhausted legacy run
 *    is settled outside `streamChat` and never reaches a `SessionFinalizer`.
 *    There is nothing to align to, so "align to the legacy" would be invention
 *    rather than parity -- and inventing a silence for a terminal the legacy
 *    never produces is exactly the behaviour change D3 declined to make.
 *  - The four early `done('completed')` exits are a MATCH and are asserted as
 *    one, with the natural end measured alongside them as the baseline that
 *    makes "the early ones are exceptions" mean something. The engine collapses
 *    all four onto `completed`, where the legacy's natural end also dispatches,
 *    so the rows agree.
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // would let `repeatFrame` survive into the next `runLegacy` call, so a test
  // that ran the dead-loop row would silently script a dead loop into every
  // later assertion in the file -- which is exactly the sort of leak that makes
  // a row mean something other than what it says.
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
// Source-level counting, for the exits that cannot be DRIVEN
// ============================================================================

/**
 * `DuyaAgent.ts`, located from this file rather than from `process.cwd()`.
 *
 * Every other test in this tree resolves its source through `import.meta.url`,
 * because a `process.cwd()`-relative path is only correct when the runner
 * happens to be at the repo root, and this file is run from a package.
 */
const DUYA_AGENT_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agent',
  'DuyaAgent.ts',
);

/**
 * Blank comments while PRESERVING every `\r` and `\n`.
 *
 * A count taken over commented source would move when a comment mentions the
 * text being counted, which would make the number a measure of documentation
 * rather than of exits. The CRLF care is the same one
 * `turn-assembly-seam.test.ts` documents: blanking `\r` as an ordinary
 * character shifts every column and diverges from the gate's own stripper.
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
  /**
   * The legacy's own dead-loop threshold, in IDENTICAL calls.
   *
   * The legacy counts the streak on `DeadLoopTracker` and the engine on
   * `RepeatedCallStreak`, and both define a repeat as same-name plus same-input,
   * so one probe calling itself with one value repeats on both. Measured rather
   * than read off a constant because the two counters are independent objects
   * and a row that assumed they agreed would be assuming the thing under test.
   */
  readonly repeatedCalls?: number;
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
  if (options.repeatedCalls !== undefined) {
    // The IDENTICAL call every turn, so the legacy's own dead-loop tracker is
    // what ends the run rather than the ceiling. The NAME is constant rather
    // than derived from the threshold, so the same input is a repeat on the
    // engine's counter too and the two rows measure the same thing.
    registry.register(
      {
        name: 'probe_repeat',
        description: 'probe that repeats itself identically',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      } as never,
      {
        execute: async () => ({ id: 'rr', name: 'probe_repeat', result: 'RAN' }),
      } as never,
    );
  }
  script({
    frames: options.frames,
    // The repeat frame is CONSTANT, so the dead-loop tracker sees the same name
    // and the same input on every turn. A per-turn id would make each call
    // distinct and the tracker would never fire.
    ...(options.repeatedCalls === undefined
      ? {}
      : {
          repeatFrame: {
            type: 'tool_use',
            data: { id: 'same', name: 'probe_repeat', input: { value: 'same' } },
          } as SSEEvent,
        }),
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
      options.maxTurns === undefined
        ? options.repeatedCalls === undefined
          ? {}
          : { maxTurns: 8, antiDeadLoop: { enabled: true, hardStopAt: options.repeatedCalls } }
        : { maxTurns: options.maxTurns },
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
    // `#shouldStop` ceiling arm is the only way it reaches its one. Without
    // this an empty engine record could be a run that ended some other way.
    expect(legacy.terminal).toBe('max_turns');
    expect(engine.reason).toBe('max_turns');

    expect(legacy.exitEvents).toEqual([]);
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

describe('the previously unmeasured exits, on BOTH paths', () => {
  it('repeated_tool_calls: the legacy dispatches NOTHING and the engine dispatches SessionEnd — recorded', async () => {
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
    const legacy = await runLegacy({ frames: [DONE_END_TURN], repeatedCalls: 2 });
    const engine = await runEngine('repeated_tool_calls');

    // Both really ended on the guard, not on the ceiling: the legacy's
    // threshold is 2 against its default ceiling of 8, and the engine's is 3
    // against the same 8.
    expect(legacy.terminal).toBe('repeated_tool_calls');
    expect(engine.reason).toBe('repeated_tool_calls');

    // A DIVERGENCE, in the same direction D3 closed, and RECORDED rather than
    // closed. `firesOnExit` silences `max_turns` but not
    // `repeated_tool_calls`, so the engine fires `SessionEnd` on a guardrail
    // that fired exactly as designed.
    //
    // It is NOT closed here for the reason D3 gives: the flip swaps a driver,
    // and a behaviour change folded into it cannot be attributed by a bisect.
    // It is also a genuinely different case from the ceiling, which is why it
    // deserves its own decision rather than D3's. The ceiling is a NORMAL
    // ending that happened to run out of turns; this is a guardrail that
    // actively stopped a run the model was not making progress on. Telling a
    // session's cleanup hooks "the agent stopped making progress and I ended
    // the run" is arguably MORE true than telling them nothing, which is the
    // argument for keeping it. The argument against is parity. The flip should
    // decide, and the decision belongs with the `SessionEnd`-on-every-terminal
    // question D3 already left open rather than in a driver swap.
    expect(legacy.exitEvents).toEqual([]);
    expect(engine.exitEvents).toEqual(['SessionEnd']);
    expect(engine.contributorCount).toBe(2);
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });

  it('budget_exhausted: there is NO legacy row, and the engine dispatches nothing either', async () => {
    // NOT MEASURED AS A PAIR, and the reason is structural rather than a gap in
    // the harness: the legacy loop has no budget exit at all. `isBudgetExhausted`
    // is called from `RunSession`, the SERVER side, and folded into
    // `resolveRunOutcome` -- so a budget-exhausted legacy run is settled outside
    // `streamChat` and never reaches a `SessionFinalizer`. Driving the legacy
    // to this path is not possible, so there is no legacy row to compare.
    //
    // What IS asserted is the engine's own behaviour, and it is the one shape
    // the ceiling row is: `budget_exhausted` is neither a failure nor a
    // cancellation, so `firesOnExit` currently says YES to `SessionEnd` and the
    // engine dispatches it. That is a DIVERGENCE from the legacy's silence, and
    // it is RECORDED here rather than closed.
    //
    // Why it is NOT closed, when D3 closed the structurally identical ceiling
    // row: the ceiling row had a legacy measurement to align to, taken on a
    // path the legacy genuinely walks. This one has no legacy path to walk, so
    // "align to the legacy" has no referent -- the choice would be invention
    // rather than parity. Inventing a silence for a terminal the legacy never
    // produces is a behaviour change with no evidence behind it, which is
    // exactly what D3 declined to do. The flip should decide it with the
    // `SessionEnd`-on-every-terminal question D3 already left open.
    const engine = await runEngine('budget_exhausted');

    // The run really ended on the budget: the port's ceiling is one tool call
    // and the engine's own spend is what crosses it, so this is the engine's
    // decision rather than an injected reason.
    expect(engine.reason).toBe('budget_exhausted');
    expect(engine.contributorCount).toBe(2);

    // The recorded divergence, asserted so it cannot drift unnoticed.
    expect(engine.exitEvents).toEqual(['SessionEnd']);
    expect(engine.invokedHooks).toEqual(['SessionEnd']);
  });

  it('the four early done(completed) exits: the legacy dispatches NOTHING on all four', async () => {
    // All four are the same shape, which is why they are one test rather than
    // four: each yields `done('completed')` and returns from `streamChat`
    // without ever calling a `SessionFinalizer`. The four are the `/goal`
    // continuation, `/export`, the mailbox soft stop, and a background resume
    // with nothing to claim.
    //
    // The engine collapses all four onto ONE `completed` reason, and on
    // `completed` it dispatches `SessionEnd` -- because `finalizeSuccess` is the
    // legacy's own method for a natural end, and the four early exits land on
    // the same terminal event the natural path produces. So these rows MATCH
    // the legacy: the legacy's early exits reach no dispatch site, and neither
    // does the engine's equivalent.
    //
    // Two of the four are driven below and the other two are asserted as
    // source, because reaching them needs a control command and a mailbox row
    // and neither is what this file is for. The claim is about where the
    // dispatch sites ARE, and that is a question about the source.
    // Two ordinary turns on the legacy, neither of which is one of the four
    // early exits -- so what this establishes is the BASELINE those four are
    // exceptions to: a turn that really ran dispatches `SessionEnd` through
    // `finalizeSuccess`. Without it, "the early exits dispatch nothing" could
    // be a property of the harness rather than of those four exits.
    //
    // Both end in `end_turn` and neither asks for a tool, for the reason the
    // dead-loop row documents: a `tool_use` stop means `needsFollowUp`, so the
    // loop goes round again and this fixture would replay its last frame until
    // it hit the ceiling, measuring a ceiling rather than a normal end.
    for (const frames of [
      [{ type: 'text', data: 'a' } as const, DONE_END_TURN as const],
      [
        { type: 'text', data: 'b', } as const,
        DONE_END_TURN as const,
      ],
    ]) {
      const legacy = await runLegacy({ frames: [...frames] });
      expect(legacy.terminal).toBe('completed');
      expect(legacy.exitEvents).toEqual(['SessionEnd']);
    }

    // The engine side, once, through the same channel. The claim is that the
    // engine's `completed` agrees with the legacy's NATURAL end.
    const engine = await runEngine('completed');
    expect(engine.reason).toBe('completed');
    expect(engine.contributorCount).toBe(2);
    expect(engine.exitEvents).toEqual(['SessionEnd']);

    // The remaining two early exits, pinned at the SOURCE rather than measured.
    // Four is the count, and the count is the claim: a fifth would be an exit
    // nobody measured. Counted over `DuyaAgent.ts` with comments stripped, the
    // same way the seam test does it, so a comment cannot change the number.
    const legacySource = stripComments(
      readFileSync(DUYA_AGENT_SOURCE, 'utf8'),
    );
    expect(
      (legacySource.match(/yield \{ type: 'done', reason: 'completed' \}/g) ?? []).length,
    ).toBe(4);
  });
});