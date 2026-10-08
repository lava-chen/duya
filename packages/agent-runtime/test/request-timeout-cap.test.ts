/**
 * Plan 600 S2 (per-request cancellation): the cap the legacy loop keeps
 * inline, given a home in the runtime.
 *
 * ## What this file is the proof of
 *
 * `DuyaAgent.streamChat` builds a child `AbortController` and a timer per model
 * call when `llmRequestTimeoutMs` is set (`DuyaAgent.ts:2252-2261`) and releases
 * both in a `finally` (`:3398-3403`). Measured before this slice: the option and
 * the primitive appear ZERO times in `packages/agent-runtime`, so a turn loop
 * migrated onto the engine would have had nowhere to put the cap and would have
 * lost it silently. This file proves the runtime now owns it, on the three
 * properties the legacy discipline actually rests on:
 *
 *  1. **The cap ends the REQUEST.** The run's own signal is the engine's and
 *     outlives the request (`run-engine.ts:237`), so a timeout that reached it
 *     would kill the run rather than the call.
 *  2. **No cap means no timer.** Not "the timer happens to be harmless" -- no
 *     timer object is created at all, which is the absence `DuyaAgent.ts:2255`
 *     guards with `if (... && ... > 0)`.
 *  3. **Both are released when the request settles**, on the completing path AND
 *     the throwing one.
 *
 * ## Why every assertion compares two different sources
 *
 * The timer count is sampled from INSIDE `ModelPort.stream`, i.e. while the
 * request is genuinely open, because a count taken after the run settles is
 * zero whether the timer was cleared or was never armed -- the assertion would
 * pass for the wrong reason. The stale-timer proof is the reverse: it advances
 * the clock far past the cap AFTER the request settled and asserts the settled
 * request's signal is still un-aborted, which is only true if the timer was
 * cleared rather than left to fire (`dispose` deliberately does NOT abort the
 * child, so a leaked timer is directly observable).
 *
 * The "the run survives its own timeout" case is the one that pins the run
 * signal apart from the request signal, and it is deliberately built around a
 * port that IGNORES its abort: that is the real shape of the risk (a socket that
 * does not die when the signal fires), and it is the only shape in which the
 * run is still live at the moment the difference is observable. `handle.stop`
 * then reports `requested: true`, which is exactly the receipt that flips to
 * `false` if the timeout reached the run's controller instead of the child's.
 *
 * ## Not proven here
 *
 * That a real undici request dies when this signal fires. Every provider in this
 * file is a generator. What is proven is that the signal reaches the port, which
 * is the half the runtime owns; the other half belongs to the transport.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  EngineRunReport,
  ModelFrame,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDrainItem,
} from '@duya/agent-runtime';
import type { RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-request-cap' as RunId;
const CAP_MS = 5_000;
/** Ten caps. Anything still pending after this was never released. */
const TEN_CAPS_MS = CAP_MS * 10;

const MANIFEST = {
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
  agent: { model: 'test-model', providerId: 'test-provider' },
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
    projectId: { source: 'unsupported', synthesised: true },
  },
} as unknown as RunManifest;

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'hello' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

/** Resolves when the signal fires, or immediately if it already has. */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * How the model port behaves. Each is a shape a real provider can take, not a
 * flag that makes an assertion easier.
 */
type Mode =
  /** Produces a normal answer and ends the turn. */
  | 'answer'
  /** Asks for one read-only tool on the first request, then answers. Two requests. */
  | 'tool-then-answer'
  /** Never produces a frame, and rethrows the abort reason when it fires. */
  | 'hang-then-rethrow'
  /** Never produces a frame and never notices the abort -- a dead socket. */
  | 'hang-until-gate'
  /** Throws on the first frame, with no abort involved. */
  | 'throw-now';

/** The call `tool-then-answer` dispatches, so the run takes a second request. */
const READ_CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: {},
  sideEffect: 'read_only',
};

interface HarnessOptions {
  /** Omit the field entirely -- the state every run is in today. */
  readonly omitCap?: boolean;
  readonly cap?: number;
  readonly mode?: Mode;
  readonly maxTurns?: number;
}

interface Observation {
  readonly signal: AbortSignal;
  /** Sampled WHILE the request was open, not after it settled. */
  readonly timersDuringRequest: number;
}

interface Harness {
  readonly observations: Observation[];
  readonly reports: EngineRunReport[];
  readonly terminals: string[];
  /** The signal the engine hands to the ports generally, captured at the drain. */
  readonly drainSignals: AbortSignal[];
  /** Open the gate a `hang-until-gate` port is parked on. */
  openGate(): void;
  stop(reason: string): Promise<{ requested: boolean; disposition: string }>;
  readonly completed: Promise<void>;
  readonly callerSignal: AbortSignal;
}

function harness(options: HarnessOptions = {}): Harness {
  const mode = options.mode ?? 'answer';
  const observations: Observation[] = [];
  const reports: EngineRunReport[] = [];
  const terminals: string[] = [];
  const drainSignals: AbortSignal[] = [];
  const caller = new AbortController();

  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const model: ModelPort = {
    async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> {
      observations.push({ signal, timersDuringRequest: vi.getTimerCount() });
      switch (mode) {
        case 'answer':
          yield { type: 'text', text: 'the answer' };
          yield { type: 'turn_stopped', reason: 'end_turn' };
          return;
        case 'tool-then-answer':
          // A dispatched call is what makes the loop take a second request
          // (`run-engine.ts:1161`): a turn that dispatched nothing has nothing
          // to feed back, so the run stops instead of asking again.
          if (observations.length === 1) {
            yield { type: 'tool_use', call: READ_CALL };
          } else {
            yield { type: 'text', text: 'the answer' };
          }
          yield { type: 'turn_stopped', reason: 'end_turn' };
          return;
        case 'throw-now':
          throw new Error('the provider died');
        case 'hang-then-rethrow':
          await untilAborted(signal);
          throw signal.reason;
        case 'hang-until-gate':
          // Deliberately deaf to the signal: this is the case that proves the
          // run's own authority was not the thing the cap fired.
          await gate;
          yield { type: 'turn_stopped', reason: 'cancelled' };
          return;
      }
    },
  };

  const tools = {
    dispatch(_call: ToolCallRequest): void {},
    async *drain(signal: AbortSignal): AsyncIterable<ToolDrainItem> {
      drainSignals.push(signal);
    },
    discard(): void {},
    describe: (): readonly { name: string; description: string; inputSchema: Record<string, never> }[] => [],
  };

  const ports: RunEnginePorts = {
    // Required since A3-1. A host with nothing queued SAYS so rather
    // than leaving the port out, which is a compile error -- the
    // engine would otherwise skip the sweep and drop mid-run steering
    // with nothing reporting the loss.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    // The three ports the legacy-still-drives window closed (plan 610 D4, then
    // D1 for `modeExit`), each the smallest honest answer. This file measures the
    // model's own timeout, so a bound no-op on these three cannot extend a
    // deadline or shorten one -- which is the property under test.
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined' as const, reason: 'not under test' }),
      nextCompactionId: () => 'cmp-timeout',
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    model,
    tools,
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(): void {},
      proposeTerminal(candidate): void {
        terminals.push(candidate.state.status);
      },
    } as RunEventStorePort,
    sideEffects: {
      async begin(call) {
        return {
          attemptKey: `key:${call.callId}`,
          runId: RUN_ID,
          runEpoch: 1,
          fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
        };
      },
      async settle(): Promise<void> {},
      async reconcile(): Promise<void> {},
      async read() {
        return [];
      },
    },
  };

  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: options.maxTurns ?? 3,
    onReport: (report) => reports.push(report),
  });

  const cap = options.cap ?? CAP_MS;
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: caller.signal,
    ports,
    // The conditional spread, because the package compiles with
    // `exactOptionalPropertyTypes`: an absent cap must be OMITTED, not passed
    // as `undefined`, and the "no cap" case is half of what this file proves.
    ...(options.omitCap === true ? {} : { modelRequestTimeoutMs: cap }),
  });

  return {
    observations,
    reports,
    terminals,
    drainSignals,
    openGate,
    stop: async (reason: string) => {
      // The real `StopRequest` shape -- `graceMs` plus a reason
      // (`execution-channel.ts:68-73`). A stop with no recorded reason is a kill
      // in the durable log nobody can account for, so the harness states both.
      const receipt = await handle.stop({ graceMs: 1_000, reason });
      return { requested: receipt.requested, disposition: receipt.disposition };
    },
    completed: handle.completed(),
    callerSignal: caller.signal,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Let the engine actually OPEN its request.
 *
 * `execute` reaches `#run`, which awaits context assembly before the port is
 * called, so a request is not open the instant `harness` returns. This drains
 * the microtask queue until the port has been entered -- bounded, and it is
 * NOT a real-time wait: every test still runs entirely on the fake clock. The
 * callers assert on `observations.length` afterwards, so a harness that never
 * opened a request cannot pass silently.
 */
async function waitForRequest(h: Harness): Promise<void> {
  for (let tick = 0; tick < 50 && h.observations.length === 0; tick += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('the per-request cap aborts the request, not the run', () => {
  it('aborts a hung request at the cap, and the run records a failure', async () => {
    vi.useFakeTimers();
    const h = harness({ mode: 'hang-then-rethrow' });
    await waitForRequest(h);

    // Positive control for the timer: sampled inside the port, so a test that
    // only ever checked "no timer" could not pass against an implementation
    // that never armed one either.
    expect(h.observations[0]?.timersDuringRequest).toBe(1);
    expect(h.observations[0]?.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CAP_MS);
    await h.completed;

    // The request's signal fired, and it says WHY.
    expect(h.observations[0]?.signal.aborted).toBe(true);
    expect(h.observations[0]?.signal.reason).toBeInstanceOf(Error);
    expect((h.observations[0]?.signal.reason as Error).message).toBe(
      `LLM request timed out after ${CAP_MS}ms`,
    );

    // `failed`, not `cancelled`. A timeout that had reached the run's signal
    // would have taken the `isAborted` branch in `#streamModel` and proposed a
    // `cancelled` terminal, so the two are distinguishable from outside.
    expect(h.reports.map((report) => report.exit.reason)).toEqual(['failed']);
    expect(h.terminals).toEqual(['failed']);
  });

  it('leaves the run stoppable when the request outlives its own abort', async () => {
    vi.useFakeTimers();
    const h = harness({ mode: 'hang-until-gate' });
    await waitForRequest(h);

    // The cap fires and the port ignores it, which is the real failure shape.
    await vi.advanceTimersByTimeAsync(CAP_MS);
    expect(h.observations[0]?.signal.aborted).toBe(true);
    expect(h.reports).toHaveLength(0);

    // The run is STILL LIVE, and still owns its cancellation: `requested: true`
    // is the receipt that becomes `false` the moment anything has aborted the
    // engine's controller -- which is precisely what a cap that reached the run
    // instead of the request would have done.
    const stopping = h.stop('the user pressed stop');
    h.openGate();
    const receipt = await stopping;

    expect(receipt.requested).toBe(true);
    expect(receipt.disposition).toBe('cooperative');
    expect(h.terminals).toEqual(['cancelled']);

    // And the caller's own signal is still the caller's to abort.
    expect(h.callerSignal.aborted).toBe(false);
  });

  it('still lets a run-level stop cancel a request that has its own cap', async () => {
    vi.useFakeTimers();
    // A cap far beyond the test, so the two are unambiguously distinct events.
    const h = harness({ mode: 'hang-then-rethrow', cap: TEN_CAPS_MS });
    await waitForRequest(h);

    expect(h.observations[0]?.signal.aborted).toBe(false);
    const receipt = await h.stop('the user pressed stop');
    await h.completed;

    // The request died from the RUN's abort, propagated into the child, and
    // the reason is the run's -- not the cap's. Composed, not exclusive: the
    // child is a child, so a run-level abort reaches a capped request, and the
    // cap's own deadline (ten caps out) never fired.
    expect(h.observations[0]?.signal.aborted).toBe(true);
    expect((h.observations[0]?.signal.reason as Error).message).toBe('the user pressed stop');
    expect(receipt.requested).toBe(true);

    // The terminal is `failed`, NOT `cancelled`, and that is this port's doing
    // rather than the cap's: a port that RETHROWS the abort reason turns a
    // cooperative stop into a thrown turn, and `#run`'s catch records a throw as
    // `failed` (`run-engine.ts:465-468`). The case above proves the other
    // shape -- a port that ends its stream on abort yields
    // `turn_stopped: cancelled` and the run proposes `cancelled`. Which of the
    // two a real port produces is the port's business, and the terminal status
    // follows it; what the runtime owns, and what this file pins, is that the
    // signal reaching the port is the composed one in both cases.
    expect(h.terminals).toEqual(['failed']);
  });
});

describe('no cap means no timer', () => {
  it('creates no timer and hands the port the run signal itself', async () => {
    vi.useFakeTimers();
    const h = harness({ omitCap: true, mode: 'answer' });
    await waitForRequest(h);

    // Sampled while the request was open. An implementation that armed a timer
    // and cleared it on the way out would report 0 here only if the count were
    // taken after the run -- which is why it is taken here.
    expect(h.observations[0]?.timersDuringRequest).toBe(0);
    await h.completed;

    // And no child controller: the port's signal is the SAME OBJECT the rest of
    // the run is driven by. `drain` receives `ctx.signal` directly, so this
    // compares the engine's signal against the signal the request was given --
    // two different code paths, and identical only when no child was built.
    expect(h.drainSignals).toHaveLength(1);
    expect(h.observations[0]?.signal).toBe(h.drainSignals[0]);
    expect(h.terminals).toEqual(['completed']);
  });

  it('treats a cap of zero or less as no cap, as the legacy condition does', async () => {
    // `DuyaAgent.ts:2255` guards the timer with `> 0`, so 0 and a negative are
    // both "uncapped" in the legacy. Reproduced rather than tightened, because a
    // run that passes 0 meaning "no limit" must not silently acquire one.
    for (const cap of [0, -1]) {
      vi.useFakeTimers();
      const h = harness({ cap, mode: 'answer' });
      await waitForRequest(h);
      expect(h.observations[0]?.timersDuringRequest).toBe(0);
      await h.completed;
      expect(h.observations[0]?.signal).toBe(h.drainSignals[0]);
      vi.useRealTimers();
    }
  });
});

describe('the scope is released when the request settles', () => {
  it('clears the timer on the completing path', async () => {
    vi.useFakeTimers();
    const h = harness({ mode: 'answer' });
    await waitForRequest(h);
    await h.completed;

    // Nothing pending: the timer armed during the request is gone.
    expect(vi.getTimerCount()).toBe(0);

    // The decisive half. Ten caps pass. A leaked timer would fire here and
    // abort a request that finished ten caps ago -- and `dispose` does NOT
    // abort the child, so nothing else would mask it.
    await vi.advanceTimersByTimeAsync(TEN_CAPS_MS);
    expect(h.observations[0]?.signal.aborted).toBe(false);
  });

  it('clears the timer on the throwing path', async () => {
    vi.useFakeTimers();
    // Throws with no abort involved, so the only thing that can release the
    // scope is the `finally` around the request.
    const h = harness({ mode: 'throw-now' });
    await waitForRequest(h);
    await h.completed;

    expect(h.reports.map((report) => report.exit.message)).toEqual(['the provider died']);
    expect(vi.getTimerCount()).toBe(0);

    // Same decisive half: the failed request's own signal survives the clock,
    // which is only true if its timer was cleared on the way out.
    await vi.advanceTimersByTimeAsync(TEN_CAPS_MS);
    expect(h.observations[0]?.signal.aborted).toBe(false);
  });

  it('does not leave a second request at the mercy of the first request timer', async () => {
    vi.useFakeTimers();
    // Two requests in one run: turn 1 dispatches a read, so the loop asks again
    // (`run-engine.ts:1161`). Each request is capped, and each opens its own
    // scope -- so the first request's timer must be gone before the second one
    // opens, and neither request may be aborted by the other's deadline.
    const h = harness({ mode: 'tool-then-answer', maxTurns: 5 });
    await waitForRequest(h);
    await h.completed;

    expect(h.observations).toHaveLength(2);
    expect(h.reports.map((report) => report.exit.reason)).toEqual(['completed']);
    expect(h.reports[0]?.turns).toBe(2);
    // Each request armed exactly one timer, and none survived either request.
    expect(h.observations.map((observation) => observation.timersDuringRequest)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TEN_CAPS_MS);
    for (const observation of h.observations) {
      expect(observation.signal.aborted).toBe(false);
    }
  });
});
