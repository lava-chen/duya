/**
 * Plan 610 slice A3, step 1: the SAFETY NET for the turn-loop cutover.
 *
 * ## What this file is
 *
 * Plan 610 rewrites the legacy `DuyaAgent.streamChat` cycle
 * (`DuyaAgent.ts:1825-3300`) into port calls. A previous attempt at exactly
 * that refactor shipped green: `agent-process-entry.ts:2989-3008` records the
 * entry running `RunEngineImpl` per `chat:start` and it being removed again as
 * a "phantom run", with `headless-run-host.ts:22-26` logged as the fake green.
 * The gates were green while the product's turn had already changed.
 *
 * The reason those gates could not catch it: they tested the ENGINE's loop.
 * `packages/agent-runtime/test/run-engine-loop.test.ts` (20 cases) exercises
 * `RunEngineImpl` and passes whether or not the product turn works, because the
 * product turn is still `DuyaAgent.streamChat` and nothing connects the two.
 * Before this file, NO test in the repo drove a real multi-turn product turn
 * with a tool result fed back to the model.
 *
 * So these tests drive the PRODUCT turn -- the real `duyaAgent.streamChat`, the
 * real `ToolExecutionPipeline`, the real `ToolRegistry` -- with a scripted
 * model client standing in for the network. They assert observable behaviour
 * (what the model was actually SENT, which events came out, whether the loop
 * stopped) and never internal structure. A cutover that routes the turn through
 * ports and keeps this behaviour passes; one that silently stops feeding tool
 * results back does not.
 *
 * ## The specific hazard: the `discarded` one-way latch
 *
 * `StreamingToolExecutor.discarded` (`StreamingToolExecutor.ts:479`, set at
 * `:753`) is a ONE-WAY latch -- nothing clears it, and `discard()` also aborts
 * the pipeline's `siblingAbortController` (`:758`). A pipeline instance held
 * across turns therefore goes PERMANENTLY MUTE: it still accepts tools
 * (`addTool` buffers), drains nothing, and raises no error. It passes every
 * structural test and every "a tool was called" assertion.
 *
 * The assertions below are built to catch exactly that. They do not stop at
 * "a tool_use event appeared". They read the `messages` array the model client
 * was ACTUALLY invoked with, on the SECOND turn, and require the tool's own
 * return value to be present in it. Two different sources:
 *
 *   - the marker is produced by the TOOL EXECUTOR and kept in a test variable
 *     (`probe.returned()`), i.e. what the tool actually handed back;
 *   - the text is read out of the `messages` array the scripted model client
 *     received, i.e. what the MODEL was actually sent.
 *
 * A muted pipeline produces a tool_use, calls nothing, and hands the model a
 * transcript with no tool result -- so the marker is missing on turn 2 and the
 * assertion fails. This is a cross-source comparison, never `x === x`.
 *
 * Scenario 2 (tool error) carries the same property for the error branch: the
 * error marker is whatever the tool returned, and it must appear in the turn-2
 * request. An error that is swallowed instead of surfaced loses it too.
 *
 * ## Why `@duya/ai` is mocked and the IPC is faked
 *
 * Both are host boundaries, not the turn:
 *
 *   - `this.llmClient` is built inside the constructor by `createAIClient`
 *     (`DuyaAgent.ts:630`, `:636`) with no injection seam, so a scripted
 *     provider must override the two factories. Only those are replaced;
 *     everything else -- the transform chain, the retry policy, the pipeline,
 *     the loop -- is the production code. This is the same seam
 *     `src/agent/__tests__/model-leg.test.ts` uses to drive a real turn.
 *   - `streamChat` reads mode state and claims mailbox rows over the worker IPC
 *     bridge before its first model request. Under a Vitest pool worker
 *     `process.send` is the pool's own channel, not the agent's, so it is
 *     replaced with a fake that answers exactly `modeState:get` and
 *     `mailbox:claimBatch`. Anything else is a test-visible failure. This is
 *     the same fake `model-leg.test.ts` uses (`test file :144-164`).
 *
 * ## What these tests do NOT claim
 *
 * They are not E2E and not a substitute for a live provider or an Electron
 * host. They cover four of the six scenarios plan 610 Step 4 names -- multi-turn,
 * tool error, cancel, and the stop decision -- at the product-turn level with a
 * scripted model. Storage rejection, worker exit, and slow-consumer
 * backpressure (the other three Step 4 scenarios) are NOT covered here: each
 * needs a persistence layer or a worker process that this unit environment does
 * not stand up. See the report for the exact reason.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
// Types come from the agent's OWN types module, which re-exports both
// (`src/types.ts:58`, `:63`), rather than from `@duya/ai`. The import audit
// counts every import statement -- type-only included -- as a cross-boundary
// edge, so sourcing them from inside `pkg:agent` is what keeps this file from
// moving the `module-dependency-permitted` self-test count.
import type { Message, SSEEvent } from '../../../src/types.js';

interface FakeDbRequest {
  type: string;
  id: string;
  action: string;
}

// ============================================================================
// The scripted model client (installed via the @duya/ai factory seam)
// ============================================================================

/** One provider turn's worth of SSE frames. */
type TurnScript = readonly SSEEvent[];

const DONE_END_TURN: SSEEvent = { type: 'done', reason: 'end_turn' };

interface RequestSnapshot {
  /** tool_result / tool-role message contents present in the request. */
  toolResultTexts: string[];
  /** Every message role in the request, in order. */
  roles: string[];
}

interface ScriptedClient {
  /** Number of times the model leg was opened (== turns that reached the LLM). */
  readonly calls: () => number;
  /** Per-turn snapshot of what the model was actually sent. */
  readonly seen: readonly RequestSnapshot[];
  streamChat: (
    messages: Message[],
    options?: Record<string, unknown>,
  ) => AsyncGenerator<SSEEvent, void, unknown>;
}

/**
 * A client that replays one script per turn and records, ON EACH CALL, what the
 * model was handed.
 *
 * The snapshot is computed at the top of `streamChat`, synchronously, BEFORE
 * any frame is yielded. That matters: `runTurnStream` passes a MUTABLE
 * `messages` reference to the client (`TurnStreamRunner.ts:153`), and the agent
 * keeps pushing into that same array. Reading it later would compare a value
 * against its own future mutation; reading it here captures the request as the
 * model leg actually saw it.
 */
function scriptedModel(scripts: readonly TurnScript[]): ScriptedClient {
  const seen: RequestSnapshot[] = [];
  let call = 0;

  return {
    calls: () => call,
    seen,
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      // Snapshot the per-request view the model leg was opened with.
      seen.push({
        toolResultTexts: toolResultTexts(messages),
        roles: messages.map((m) => m.role),
      });

      const script = scripts[Math.min(call, scripts.length - 1)];
      call += 1;

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
}

/** The client the mocked factory hands to whichever agent is being built. */
let activeClient: ScriptedClient | null = null;

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegatingClient = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      if (!activeClient) throw new Error('no scripted client installed for this test');
      return activeClient.streamChat(messages, options);
    },
  };
  return {
    ...actual,
    createAIClient: () => delegatingClient,
    createAIClientWithRetry: () => delegatingClient,
  };
});

/**
 * The 'message' listeners already attached to this process BEFORE any duya
 * module is imported -- i.e. the Vitest pool worker's own IPC listeners.
 *
 * Captured at module scope, ahead of the dynamic imports below, because the
 * db-client's listener is indistinguishable from the pool's by name. The pool
 * listener must never be called with a plain object: it deserializes its
 * argument as a Buffer and throws (the ~20 unhandled errors the sibling
 * `src/agent/__tests__/model-leg.test.ts` reports come from exactly that).
 * So the db response is delivered to the db-client's listener directly, found by
 * subtracting these.
 */
const PRE_EXISTING_MESSAGE_LISTENERS = new Set(process.listeners('message'));

const { duyaAgent } = await import('../../../src/agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../../src/tool/registry.js');
const { initDbClient } = await import('../../../src/ipc/db-client.js');

/**
 * Every tool-result text present in a request's `messages`, read from the live
 * array at call time.
 *
 * Covers both carriers the loop can produce: a `role: 'tool'` message with
 * string content, and a message whose content array carries a `tool_result`
 * block. The loop's own backfill (`DuyaAgent.ts:2787-2804`) decides which, so
 * the extraction mirrors both shapes rather than assuming one.
 */
function toolResultTexts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && typeof m.content === 'string') {
      out.push(m.content);
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
          const content = (block as { content: unknown }).content;
          out.push(typeof content === 'string' ? content : JSON.stringify(content));
        }
      }
    }
  }
  return out;
}

// ============================================================================
// The offline host: env, the worker IPC, and the scripted client
// ============================================================================

const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

/**
 * The db-client's own `process.on('message', ...)` listener, captured once.
 *
 * Captured rather than reached through `process.emit('message', ...)`: under a
 * Vitest pool worker the process ALSO carries the pool's own IPC listener, and
 * emitting a plain object on that channel makes the pool try to deserialize it
 * as a Buffer, which throws an unhandled rejection (this is why the sibling
 * `src/agent/__tests__/model-leg.test.ts` reports ~20 unhandled errors). Calling
 * the db-client's listener directly delivers the response to the only consumer
 * that cares and never touches the pool's channel.
 */
let dbResponseListener: ((msg: unknown) => void) | null = null;

beforeEach(() => {
  // Keep the god class constructible and offline: no real endpoint, no session
  // persistence, no real sessions/memory roots.
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  activeClient = null;
});

/**
 * Install the fake worker IPC the turn reaches for before its first request.
 *
 * `streamChat` reads mode state and claims mailbox rows through this bridge
 * before its first model request. Under a Vitest pool worker `process.send` is
 * the pool's own channel, not the agent's, so it is replaced. Answering exactly
 * the two actions this turn issues keeps the fixture small; anything else
 * arriving is a test-visible failure rather than a hang.
 */
function installFakeDbIpc(): void {
  if (!dbResponseListener) {
    // `initDbClient()` runs on module load (`db-client.ts:1151`), so the
    // listener is already attached; the call is an idempotent no-op that
    // guarantees presence. The db-client's listener is then the one NOT in the
    // pre-existing (pool) set.
    initDbClient();
    const added = process
      .listeners('message')
      .filter((l) => !PRE_EXISTING_MESSAGE_LISTENERS.has(l));
    dbResponseListener = (added[0] ?? null) as ((msg: unknown) => void) | null;
    if (!dbResponseListener) throw new Error('db-client registered no message listener');
  }

  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as FakeDbRequest;
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action in turn-loop test: ${req.action}`);
    }
    // null = no mode snapshot; an EMPTY claim, not a null, because the loop
    // reads `claim.rows`.
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => {
      dbResponseListener?.({
        type: 'db:response',
        id: req.id,
        success: true,
        result,
      });
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
    sessionId: `s-turn-loop-${sessionCounter}-${Math.random().toString(36).slice(2)}`,
    workingDirectory: process.cwd(),
    // Auto-allow so the probe tool runs instead of raising an approval the
    // test never answers. Gating is a separate concern.
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// The probe tool
// ============================================================================

interface ProbeSpec {
  mode: 'ok' | 'error';
  /** Called when the executor starts, used by the abort test to fire a timer. */
  onStart?: () => void;
  /** Optional gate the executor awaits before returning (abort test). */
  gate?: Promise<void>;
}

interface Probe {
  /** How many times the executor ran. */
  readonly runCount: () => number;
  /** The exact string the executor returned on its last run, or null. */
  readonly returned: () => string | null;
}

/**
 * A minimal tool whose only job is to hand back a marker the test can find.
 *
 * The marker is generated ONCE by the executor and stored, so the later
 * assertion compares "what the tool returned" (this closure) against "what the
 * model received" (the client's snapshot) -- two independent sources. A muted
 * pipeline never produces a value here, and the turn-2 snapshot lacks the
 * marker, which is the failure this whole file exists to catch.
 */
function makeProbeTool(name: string, marker: string, spec: ProbeSpec): {
  probe: Probe;
  executor: { execute: (input: Record<string, unknown>) => Promise<{ id: string; name: string; result: string; error?: boolean }> };
} {
  let runCount = 0;
  let returned: string | null = null;

  const execute = async (input: Record<string, unknown>) => {
    runCount += 1;
    spec.onStart?.();
    if (spec.gate) await spec.gate;
    if (spec.mode === 'error') {
      returned = `${marker}: simulated tool failure`;
      return { id: 'r1', name, result: returned, error: true };
    }
    returned = `${marker}:${String(input.value ?? '')}`;
    return { id: 'r1', name, result: returned };
  };

  return {
    probe: {
      runCount: () => runCount,
      returned: () => returned,
    },
    executor: { execute },
  };
}

function registryWith(
  name: string,
  description: string,
  executor: { execute: (input: Record<string, unknown>) => Promise<unknown> },
): InstanceType<typeof ToolRegistry> {
  const registry = new ToolRegistry();
  // The executor is what actually runs; the definition supplies the catalog
  // name/schema. Both are needed for the tool to be declared (visibility guard)
  // and dispatchable (registry lookup).
  registry.register(
    {
      name,
      description,
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    executor as never,
  );
  return registry;
}

async function collect(
  agent: InstanceType<typeof duyaAgent>,
  prompt: string,
  registry: InstanceType<typeof ToolRegistry>,
  options: Record<string, unknown> = {},
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of agent.streamChat(prompt, {
    toolRegistry: registry,
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

function eventsOfType(events: readonly SSEEvent[], type: SSEEvent['type']): SSEEvent[] {
  return events.filter((e) => e.type === type);
}

// ============================================================================
// 1. Multi-turn with a tool call
// ============================================================================

describe('product turn: multi-turn with a tool call feeds the result back', () => {
  it('calls the tool once and the SECOND turn actually receives its result', async () => {
    installFakeDbIpc();
    const MARKER = 'PROBE-OK-7f3a';
    const { probe, executor } = makeProbeTool('probe_ok', MARKER, { mode: 'ok' });

    const model = scriptedModel([
      // Turn 1: ask for the tool, then end this provider turn.
      [
        { type: 'text', data: 'calling the probe' },
        { type: 'tool_use', data: { id: 't1', name: 'probe_ok', input: { value: 'alpha' } } },
        DONE_END_TURN,
      ],
      // Turn 2: the model should now SEE the tool result and stop.
      [{ type: 'text', data: 'I can see the probe result.' }, DONE_END_TURN],
    ]);
    activeClient = model;

    const registry = registryWith('probe_ok', 'probe that succeeds', executor);
    const events = await collect(makeAgent(), 'run the probe then report', registry);

    // The loop really ran (guard against a vacuous green).
    expect(model.calls()).toBe(2);
    expect(eventsOfType(events, 'tool_use').length).toBe(1);
    expect(eventsOfType(events, 'tool_result').length).toBe(1);

    // The tool ran exactly once.
    expect(probe.runCount()).toBe(1);

    // THE cross-source assertion. The marker the executor returned
    // (`probe.returned()`, source A) must be present in the messages the model
    // client was actually invoked with on turn 2 (source B). A muted/discarded
    // pipeline calls nothing and feeds back nothing, so this fails there.
    const returned = probe.returned();
    expect(returned).not.toBeNull();
    const turn2Texts = model.seen[1]?.toolResultTexts ?? [];
    expect(turn2Texts.length).toBeGreaterThan(0);
    expect(turn2Texts.some((t) => t.includes(returned as string))).toBe(true);

    // The transcript shape the model saw is assistant(tool_use) then a tool
    // result -- observed on the request, not inferred.
    const turn2Roles = model.seen[1]?.roles ?? [];
    expect(turn2Roles).toContain('assistant');
    expect(turn2Roles).toContain('tool');

    // Turn 2 saw the value it asked for.
    expect(turn2Texts.some((t) => t.includes('alpha'))).toBe(true);
  });
});

// ============================================================================
// 2. Tool error
// ============================================================================

describe('product turn: a tool error is surfaced to the model and the loop continues', () => {
  it('feeds the failure back to the model and keeps going', async () => {
    installFakeDbIpc();
    const MARKER = 'PROBE-ERR-4b2e';
    const { probe, executor } = makeProbeTool('probe_err', MARKER, { mode: 'error' });

    const model = scriptedModel([
      [
        { type: 'tool_use', data: { id: 't1', name: 'probe_err', input: { value: 'boom' } } },
        DONE_END_TURN,
      ],
      // Turn 2 runs because turn 1's tool result set needsFollowUp; it sees
      // the error and stops.
      [{ type: 'text', data: 'The tool failed; I will report that.' }, DONE_END_TURN],
    ]);
    activeClient = model;

    const registry = registryWith('probe_err', 'probe that fails', executor);
    const events = await collect(makeAgent(), 'run the failing probe', registry);

    // This is the MEASURED behaviour, not an assumption: `addTool` sets
    // needsFollowUp, the error is backfilled as a tool message
    // (StreamingToolExecutor.ts:1543), and the stop decision on turn 2 is the
    // model's `done` with no further tool.
    expect(model.calls()).toBe(2);
    expect(probe.runCount()).toBe(1);

    // The error marker (what the tool returned, source A) must appear in the
    // turn-2 request (what the model was sent, source B). A swallowed error
    // loses it.
    const returned = probe.returned();
    expect(returned).not.toBeNull();
    const turn2Texts = model.seen[1]?.toolResultTexts ?? [];
    expect(turn2Texts.some((t) => t.includes('simulated tool failure'))).toBe(true);
    expect(turn2Texts.some((t) => t.includes(returned as string))).toBe(true);

    // The error is delivered as a tool result, observable on the event stream.
    expect(eventsOfType(events, 'tool_result').length).toBe(1);
  });
});

// ============================================================================
// 3. Stop decision
// ============================================================================

describe("product turn: the model's stop signal ends the loop, not the ceiling", () => {
  it('stops after one turn even with a high maxTurns ceiling', async () => {
    installFakeDbIpc();
    const model = scriptedModel([
      // A single turn that asks for nothing: text, then done. needsFollowUp
      // stays false, so the loop must finalize here.
      [{ type: 'text', data: 'nothing to do; done.' }, DONE_END_TURN],
    ]);
    activeClient = model;

    // A generous ceiling: if the loop wrongly continued it would call the
    // model many more times. Stopping at one call proves the STOP SIGNAL
    // (not the cap) ended the run.
    const events = await collect(makeAgent(), 'say you are done', new ToolRegistry(), {
      maxTurns: 10,
    });

    expect(model.calls()).toBe(1);
    expect(eventsOfType(events, 'text').length).toBeGreaterThan(0);
    // It finalized on the model's own end_turn, not the max_turns ceiling.
    const done = eventsOfType(events, 'done');
    expect(done.length).toBeGreaterThan(0);
    expect((done[done.length - 1] as { reason?: string }).reason).not.toBe('max_turns');
  });
});

// ============================================================================
// 4. Abort mid-turn
// ============================================================================

describe('product turn: an abort mid-turn stops promptly with no background drain', () => {
  it('ends the stream, does not start another turn, and the late tool is inert', async () => {
    installFakeDbIpc();
    const MARKER = 'PROBE-ABORT-9c1d';
    let releaseTool: (() => void) | null = null;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });

    // Tool blocks until the test releases it, so the abort lands while a tool
    // is genuinely mid-flight. onStart schedules the abort on the next
    // macrotask, i.e. once the tool is executing and the drain is awaiting it.
    let agentRef: InstanceType<typeof duyaAgent> | null = null;
    const { executor } = makeProbeTool('probe_abort', MARKER, {
      mode: 'ok',
      onStart: () => {
        setTimeout(() => agentRef?.interrupt(), 0);
      },
      gate: toolGate,
    });

    const model = scriptedModel([
      [
        { type: 'tool_use', data: { id: 't1', name: 'probe_abort', input: { value: 'hold' } } },
        DONE_END_TURN,
      ],
      // Should never be reached: the abort stops the loop before turn 2.
      [{ type: 'text', data: 'should not happen' }, DONE_END_TURN],
    ]);
    activeClient = model;

    agentRef = makeAgent();
    const registry = registryWith('probe_abort', 'probe that blocks', executor);

    // Consume the stream to completion. The abort fires while the drain awaits
    // the blocked tool (the executor races tool execution against the abort
    // signal, StreamingToolExecutor.ts:1460); the loop must unwind rather than
    // hang. If a pipeline were left draining, this await would time out.
    const events = await collect(agentRef, 'run the blocking probe', registry);

    // It stopped: the generator finished, so the for-await resolved.
    expect(Array.isArray(events)).toBe(true);

    // No second model turn: the abort ended the loop before the follow-up.
    expect(model.calls()).toBe(1);

    // Now release the blocked tool AFTER the stream ended. Its late completion
    // must be inert: no new tool result reaching a model, no new turn.
    releaseTool?.();
    await new Promise((r) => setTimeout(r, 50));

    // Still one turn, and the released tool did not open a new request. This is
    // the "no background drain reaching the model" half. The transcript the
    // model saw on turn 1 had no tool result, and no turn 2 was opened to
    // receive one.
    expect(model.calls()).toBe(1);
    const turn1Texts = model.seen[0]?.toolResultTexts ?? [];
    expect(turn1Texts.length).toBe(0);
  });
});

// ============================================================================
// 5. Plan 610 A3-2b2: binding `turnOutput` must not disturb the legacy
//
// ============================================================================

describe('product turn: a bound turn-output sink does not change the legacy', () => {
  /**
   * Run the SAME turn twice -- once with a sink bound, once without -- and
   * compare what came OUT.
   *
   * The comparison is the point. Asserting only "the sink got nothing" would
   * pass against a legacy that had been quietly broken, and asserting only
   * "the events still look right" would pass against a sink that swallowed the
   * frames while leaving the yields alone. Running both and requiring the
   * observable output to be IDENTICAL is the only shape that rules out both.
   *
   * A FAILING tool is used deliberately: it is the one input that exercises
   * `PostToolUseFailure` as well as the `tool_result` frame, so the two effects
   * this slice gave a route to are both in the path.
   */
  async function runTwice(sink: ((event: SSEEvent) => void) | null): Promise<{
    events: SSEEvent[];
    frames: SSEEvent[];
    finished: number;
    transcript: readonly Message[];
    sinkSaw: SSEEvent[];
    modelSaw: readonly RequestSnapshot[];
    agent: InstanceType<typeof duyaAgent>;
  }> {
    const run = async (bind: boolean) => {
      // Every run installs the fake worker IPC itself: `streamChat` reads mode
      // state over that bridge before its first request, so a run without it
      // hands a raw object to the pool worker's own `process.on('message')`.
      installFakeDbIpc();
      const { executor } = makeProbeTool('probe_bound', 'PROBE-BOUND-2c8e', { mode: 'error' });
      const model = scriptedModel([
        [
          { type: 'tool_use', data: { id: 't1', name: 'probe_bound', input: { value: 'x' } } },
          DONE_END_TURN,
        ],
        [{ type: 'text', data: 'reported' }, DONE_END_TURN],
      ]);
      activeClient = model;
      const agent = makeAgent();
      const sinkSaw: SSEEvent[] = [];
      let finished = 0;
      if (bind) {
        agent.bindTurnOutputSink({
          publish: (event) => sinkSaw.push(event),
          finishTurn: () => {
            finished += 1;
          },
        });
      }
      const registry = registryWith('probe_bound', 'failing probe', executor);
      const events = await collect(agent, 'run the probe then report', registry);
      return {
        events,
        frames: eventsOfType(events, 'tool_result'),
        finished,
        transcript: agent.messages,
        sinkSaw,
        modelSaw: model.seen,
        agent,
      };
    };

    if (sink !== null) {
      const bound = await run(true);
      const plain = await run(false);
      // The two runs must agree on everything a consumer of the legacy stream
      // could see. `frames` is the load-bearing one: it is the frame this slice
      // refactored into a shared builder.
      expect(bound.frames).toEqual(plain.frames);
      expect(bound.events.length).toBe(plain.events.length);
      expect(bound.modelSaw.map((s) => s.toolResultTexts)).toEqual(
        plain.modelSaw.map((s) => s.toolResultTexts),
      );
      expect(bound.transcript.map((m) => [m.role, typeof m.content])).toEqual(
        plain.transcript.map((m) => [m.role, typeof m.content]),
      );
      return bound;
    }
    return run(false);
  }

  it('the sink receives NOTHING while the legacy drives, and the binding is gone after', async () => {
    const r = await runTwice(() => undefined);

    // Two SEPARATE properties, and the second is the load-bearing one.
    //
    // (1) The sink saw no frames. This is structural rather than enforced:
    // nothing inside `streamChat` publishes to the sink, because the legacy's
    // frames are `yield`s of the generator and its consumer is unchanged. That is
    // why binding cannot duplicate a frame -- there is no second writer.
    expect(r.frames.length).toBe(1);
    expect(r.sinkSaw).toEqual([]);
    expect(r.finished).toBe(0);

    // (2) The binding does not outlive the run. The agent is long-lived and the
    // sink is a per-run object, so a binding left behind by an engine-driven run
    // would make a LATER legacy run address a finished run's receiver. This is
    // what the `streamChat` unbind is for, and it is asserted through the agent's
    // own accessor (left) against the sink's own counter (right) -- a stale
    // binding is observable only by asking the agent AND then writing to it.
    expect(r.agent.readTurnOutputSink()).toBeNull();
    r.agent.finishTurnOutput({ turn: 99, results: 3, dispatched: 3 });
    expect(r.finished).toBe(0);
  });

  it('re-binding the sink after the legacy started is what the composition does', async () => {
    // The complementary direction, and the one the driver flip depends on: with
    // the legacy NOT running, the same seam does deliver frames.
    //
    // Left: the `tool_result` frame the agent's own `_buildToolResultFrame`
    // built. Right: what the bound sink collected. The agent never sees the
    // sink's list, so it cannot have written both sides from one value.
    installFakeDbIpc();
    const { executor } = makeProbeTool('probe_seam', 'PROBE-SEAM-91ab', { mode: 'error' });
    const model = scriptedModel([
      [
        { type: 'tool_use', data: { id: 't1', name: 'probe_seam', input: { value: 'y' } } },
        DONE_END_TURN,
      ],
      [{ type: 'text', data: 'reported' }, DONE_END_TURN],
    ]);
    activeClient = model;

    const agent = makeAgent();
    const seen: SSEEvent[] = [];
    const summaries: unknown[] = [];
    agent.bindTurnOutputSink({
      publish: (event) => seen.push(event),
      finishTurn: (summary) => summaries.push(summary),
    });
    const registry = registryWith('probe_seam', 'failing probe', executor);

    await agent.recordTurnToolResult({
      message: {
        role: 'tool',
        tool_call_id: 't1',
        // The `<tool_error>` marker is not decoration: for a `role: 'tool'` row the
        // legacy INFERS the error bit from the content rather than reading a
        // field (`DuyaAgent._readToolResultOutcome`), and this assertion is what
        // proves the seam uses that same reader instead of trusting the engine's
        // tri-state. A content without the marker must read as a success.
        content: '<tool_error>PROBE-SEAM-91ab: simulated tool failure</tool_error>',
        timestamp: 1,
      },
      toolName: 'probe_seam',
      seqIndex: 42,
    });
    agent.finishTurnOutput({ turn: 1, results: 1, dispatched: 1 });

    const toolFrames = seen.filter((e) => e.type === 'tool_result');
    expect(toolFrames.length).toBe(1);
    expect((toolFrames[0]?.data as { id: string }).id).toBe('t1');
    // The error bit came from the agent's own reader, which infers it from the
    // `<tool_error>` marker in the content exactly as the legacy does.
    expect((toolFrames[0]?.data as { error: boolean }).error).toBe(true);
    expect(summaries).toEqual([{ turn: 1, results: 1, dispatched: 1 }]);

    // And the durable row really landed: the timeline is the agent's own, read
    // back through its public projection, not the value the seam was handed.
    const toolRows = agent.messages.filter((m) => m.role === 'tool');
    expect(toolRows.length).toBe(1);
    expect(toolRows[0]?.seq_index).toBe(42);
    expect(toolRows[0]?.id).toBeTruthy();
  });

  it('recordTurnAssistantMessage stamps the attribution the engine cannot supply', async () => {
    installFakeDbIpc();
    const agent = makeAgent();
    agent.recordTurnAssistantMessage({
      content: [{ type: 'text', text: 'the model answered' }],
      seqIndex: 7,
      durationMs: 12,
      usage: { input_tokens: 3, output_tokens: 5 },
    });

    const rows = agent.messages.filter((m) => m.role === 'assistant');
    expect(rows.length).toBe(1);
    // `AssistantMessageRecord` says `modelAttribution` is the HOST's and the
    // engine must not invent one; these fields exist only if the agent applied
    // its own. They are what lets `transformMessages.isSameModel` keep the next
    // turn's thinking block native instead of downgrading it.
    const row = rows[0] as Message & { model?: string; providerId?: string };
    expect(row.model).toBeTruthy();
    expect(row.providerId).toBeTruthy();
    expect(row.seq_index).toBe(7);
    // NOT asserted: `usage`. `agent.messages` is the provider-shaped projection
    // (`projectTimelinePersistenceMessages`), which is not the row -- the usage
    // block is asserted where it is actually decided, in the composition's
    // `toRowUsage`. Asserting it here would be testing the projector.
  });
});
