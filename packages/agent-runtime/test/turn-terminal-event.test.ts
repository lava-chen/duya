/**
 * T01 — the turn terminal: `turn.completed` produced by the runtime.
 *
 * ## What was missing
 *
 * `turn.completed` was registered (`events/registry.ts:196`), field-checked
 * (`events/required.ts:80`), consumed (`client-core`'s `SurfaceModel` retires the
 * open turn on it, `surface-model.ts:746`) and deliberately dropped by the
 * legacy projector (`project/legacy-sse-projector.ts:301` returns `null`) — and
 * it had NO producer. `run-engine.ts` published `turn.started` and never its
 * counterpart, so a consumer could not tell "this turn finished" from "this turn
 * never finished". That is the exact gap `legacy/sse-event.ts:184` records for
 * the legacy surface, and plan 610 §1.2 G1 records that it survived the
 * migration.
 *
 * ## The three things this file pins
 *
 * 1. A turn that ran gets exactly ONE terminal carrying its own
 *    `turnId` / `index` / `stopReason` / `usage` / `durationMs`. Every value is
 *    compared against a literal the harness supplied, never against the event
 *    under test.
 * 2. The `seq` continues the run's single sequence. The engine cannot mint one
 *    (`ports.ts:1020` — `publish` takes a `RunEvent`, which has no `seq`), so
 *    this is asserted on the ENVELOPES the run's own emitter announced:
 *    strictly increasing across the turn boundary, never restarting per turn
 *    (17 §4.2).
 * 3. The turn terminal precedes the run terminal, in the announced order and in
 *    the `seq` that order was minted from.
 *
 * ## The two refusals — closed by T01b
 *
 * The event's whole payload was REQUIRED, and the engine only publishes what it
 * OBSERVED, so two observations that are not always available produced no event
 * at all. Both are closed now, and the wording below is the record of that:
 *
 * | observation | used to | is now |
 * | --- | --- | --- |
 * | a stop reason the union could not state (`tool_use`) | `STOP_REASON_TO_EVENT` mapped it to `null`, so the ORDINARY continuation turn got no terminal | `StopReason` carries `tool_use` and the turn reports its ending |
 * | a usage the provider never reported | `usage` was required, so silence was the only honest option | `usage` is optional and the absence is carried as an absence |
 *
 * Neither absence was pinned as "zero forever" — that is deliberate. A test
 * demanding it would have made closing the gap a regression (17 §6, plan 19
 * §10.3), and the three cases in the last describe are what replaced it: the
 * invariant that keeps holding when the vocabulary widens, which is that a
 * published terminal never carries a value the provider did not report.
 *
 * ## Still registered as explicitly UNSUPPORTED by this slice
 *
 * A turn whose model stream is cancelled or fails mid-flight publishes no
 * `turn.completed` at all: there is no turn ending to report, and the run's own
 * terminal carries the cancellation. Those paths are not reachable as a "turn
 * 收尾" today and this slice does not pretend otherwise (plan 19 T01 step 4).
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  ModelStopReason,
  RunEnginePorts,
  RunEventStorePort,
  TerminalCandidate,
  ToolCallRequest,
  ToolDrainItem,
} from '../src/engine/ports.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { RunSession } from '../src/run-session.js';
import type {
  RunEvent,
  RunEventEnvelope,
  RunMetrics,
  RunTerminalState,
} from '@duya/agent-protocol';

const RUN_ID = 'run-t01';

const MANIFEST = {
  runId: RUN_ID,
  workspace: '/tmp',
  tools: [],
  systemPrompt: 'test',
  model: 'test-model',
  providerId: 'test-provider',
  apiFormat: 'anthropic',
} as unknown as Parameters<RunEngineImpl['execute']>[0]['manifest'];

const INPUT = {
  revision: 'rev-t01',
  prompt: { role: 'user', id: 'p-t01', content: 'go' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd-t01', locator: 'catalog://t01' },
  steering: [],
  options: {},
} as unknown as Parameters<RunEngineImpl['execute']>[0]['input'];

const READ_CALL: ToolCallRequest = {
  callId: 'call-t01',
  name: 'Read',
  input: { path: 'a.txt' },
  sideEffect: 'read_only',
} as unknown as ToolCallRequest;

/**
 * One scripted turn.
 *
 * `tookMs` is engine-clock time the model stream consumes, which is the only
 * thing `durationMs` may be derived from — so a run whose turns take different
 * amounts of time can prove the event is per turn rather than run-elapsed.
 */
interface TurnPlan {
  readonly stop: ModelStopReason;
  /** Ask for a tool, which is what gives the loop a reason to continue. */
  readonly tool?: boolean;
  /** The usage frame the provider reports. Absent means it reported NONE. */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
  };
  readonly tookMs: number;
}

interface Harness {
  /** Every envelope the run's STREAM received, in announcement order. */
  readonly announced: readonly RunEventEnvelope[];
  /** What the engine proposed as the run terminal. Never invented here. */
  readonly candidate: TerminalCandidate | null;
  /** Publish the proposed terminal the way a host adapter does. */
  declare(): void;
  settle(): Promise<RunTerminalState>;
  readonly emitter: RunEventEmitter;
  readonly session: RunSession;
  readonly completed: Promise<void>;
}

/** The terminal an engine candidate projects to. Host adapter's job, spelled out here. */
function declaredEventOf(candidate: TerminalCandidate): RunEvent {
  const state = candidate.state;
  if (state.status === 'failed') return { type: 'run.failed', error: state.error };
  return {
    type: 'run.completed',
    status: state.status,
    ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    ...(state.status === 'cancelled' ? { cancelRequested: true } : {}),
  };
}

function harness(plans: readonly TurnPlan[]): Harness {
  const announced: RunEventEnvelope[] = [];
  let candidate: TerminalCandidate | null = null;

  // The engine's clock, advanced only by the scripted streams. `now` is a
  // DECISION input (`RunEngineOptions.now`), so a test that wants a duration
  // must own it rather than read the wall clock.
  let engineNow = 1_000;

  const persistence = {
    append: async (_batch: readonly RunEventEnvelope[]): Promise<void> => undefined,
    complete: async (_t: RunTerminalState, _m: RunMetrics): Promise<void> => undefined,
  };
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-t01',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: {
      push: (envelope: RunEventEnvelope): void => {
        announced.push(envelope);
      },
    },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-t01',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  let turn = 0;
  const events: RunEventStorePort = {
    publish(event: RunEvent): void {
      // Through the real emitter: it is what mints `seq`, and it is the only
      // thing that can hold a terminal. A hand-numbered stub here would let a
      // second sequence be invented and still pass.
      emitter.emit(event);
    },
    proposeTerminal(proposed): void {
      candidate = proposed;
    },
  };

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined' as const, reason: 'not under test' }),
      nextCompactionId: () => 'cmp-t01',
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    model: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
        const plan: TurnPlan = plans[turn] ?? { stop: 'end_turn', tookMs: 0 };
        turn += 1;
        if (plan.tool === true) yield { type: 'tool_use', call: READ_CALL };
        else yield { type: 'text', text: `answer ${turn}` };
        if (plan.usage !== undefined) {
          yield {
            type: 'usage',
            inputTokens: plan.usage.inputTokens,
            outputTokens: plan.usage.outputTokens,
            ...(plan.usage.totalTokens === undefined
              ? {}
              : { totalTokens: plan.usage.totalTokens }),
          };
        }
        engineNow += plan.tookMs;
        yield { type: 'turn_stopped', reason: plan.stop };
      },
    },
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        if (turn === 1 && plans[0]?.tool === true) {
          yield {
            kind: 'tool_result',
            callId: READ_CALL.callId,
            content: 'read ok',
            isError: false,
            durationMs: 3,
          } as ToolDrainItem;
        }
      },
      discard(): void {},
      describe: () => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-t01',
          revision: 'rev-t01',
        };
      },
      defer(): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events,
  };

  const engine = new RunEngineImpl({ now: () => engineNow, defaultMaxTurns: plans.length + 1 });
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: new AbortController().signal,
    ports,
  });

  return {
    announced,
    // A getter, because `execute` has only been kicked off by the time this
    // returns: the proposal lands after the loop breaks.
    get candidate(): TerminalCandidate | null {
      return candidate;
    },
    declare(): void {
      if (candidate === null) throw new Error('the engine proposed no terminal');
      emitter.emit(declaredEventOf(candidate));
    },
    settle: () => session.settle(),
    emitter,
    session,
    completed: handle.completed(),
  };
}

/** Envelopes of one type, so `seq` can be read off the thing that minted it. */
function envelopesOf<T extends RunEvent['type']>(
  seen: readonly RunEventEnvelope[],
  type: T,
): RunEventEnvelope[] {
  return seen.filter((envelope) => envelope.payload.type === type);
}

/** Payloads of one type, narrowed for the fields under test. */
function eventsOf<T extends RunEvent['type']>(
  seen: readonly RunEventEnvelope[],
  type: T,
): Array<Extract<RunEvent, { readonly type: T }>> {
  const out: Array<Extract<RunEvent, { readonly type: T }>> = [];
  for (const envelope of seen) {
    if (envelope.payload.type === type) {
      out.push(envelope.payload as Extract<RunEvent, { readonly type: T }>);
    }
  }
  return out;
}

// ============================================================================
// 1. The event exists, and it carries the turn's own facts
// ============================================================================

describe('the engine publishes turn.completed for a turn that ran', () => {
  it('carries the turn s own turnId, index, stopReason, usage and duration', async () => {
    const h = harness([
      { stop: 'end_turn', usage: { inputTokens: 120, outputTokens: 8 }, tookMs: 120 },
    ]);
    await h.completed;

    const completed = eventsOf(h.announced, 'turn.completed');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    if (event === undefined) throw new Error('expected a turn.completed');

    // Paired with the opening the engine actually published, rather than with
    // an id this test composed: the two must name the same turn.
    const started = eventsOf(h.announced, 'turn.started')[0];
    expect(started).toBeDefined();
    expect(event.turnId).toBe(started?.turnId);
    expect(event.turnId).toBe(`${RUN_ID}:turn:1`);
    expect(event.index).toBe(1);

    // Every value below is compared against a LITERAL the harness supplied, so
    // removing the producer or substituting a default is observable.
    expect(event.stopReason).toBe('end_turn');
    expect(event.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128 });
    expect(event.durationMs).toBe(120);
  });

  it('continues the run s single sequence, and states each turn s own duration', async () => {
    const h = harness([
      { tool: true, stop: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, tookMs: 120 },
      { stop: 'end_turn', usage: { inputTokens: 30, outputTokens: 5 }, tookMs: 80 },
    ]);
    await h.completed;

    const started = envelopesOf(h.announced, 'turn.started');
    const completed = envelopesOf(h.announced, 'turn.completed');
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(2);

    // The position, not merely the number: a per-turn counter would put turn
    // 2's opening back at the front of the run's ordinal space.
    expect(completed[0]?.seq ?? 0).toBeGreaterThan(started[0]?.seq ?? 0);
    expect(started[1]?.seq ?? 0).toBeGreaterThan(completed[0]?.seq ?? 0);
    expect(completed[1]?.seq ?? 0).toBeGreaterThan(started[1]?.seq ?? 0);

    // And the whole announcement is ONE strictly increasing sequence with no
    // repeats — not just the four positions checked above.
    const seqs = h.announced.map((envelope) => envelope.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Per TURN, not run-elapsed: turn 2 would read 200 if the clock were
    // measured from the run's start.
    expect(eventsOf(h.announced, 'turn.completed').map((e) => e.durationMs)).toEqual([120, 80]);
    expect(eventsOf(h.announced, 'turn.completed').map((e) => e.index)).toEqual([1, 2]);
  });

  it('announces the turn terminal AHEAD of the run terminal', async () => {
    const h = harness([
      { stop: 'end_turn', usage: { inputTokens: 40, outputTokens: 4 }, tookMs: 60 },
    ]);
    await h.completed;

    // The premise: the engine declared an ending, so there IS a run terminal to
    // order against.
    expect(h.candidate?.state.status).toBe('completed');
    h.declare();
    const committed = await h.settle();
    await h.emitter.publishCommittedTerminal(committed);

    const turnTerminal = envelopesOf(h.announced, 'turn.completed')[0];
    const runTerminal = envelopesOf(h.announced, 'run.completed')[0];
    if (turnTerminal === undefined) throw new Error('expected a turn.completed');
    if (runTerminal === undefined) throw new Error('expected a run.completed');

    // Both sides: the ORDER a consumer reads, and the `seq` it is derived from.
    expect(turnTerminal.seq).toBeLessThan(runTerminal.seq);
    const types = h.announced.map((envelope) => envelope.payload.type);
    expect(types.lastIndexOf('turn.completed')).toBeLessThan(types.lastIndexOf('run.completed'));
  });
});

// ============================================================================
// 2. The two refusals — no event, and no invented value
// ============================================================================

describe('T01b: every turn that ran reports its ending', () => {
  it('a tool-continuation turn also reports its ending', async () => {
    // Was a refusal, and was the ORDINARY agent turn: the model asked for tools
    // and the loop went round again. `tool_use` was a `ModelStopReason` with no
    // member in the event `StopReason`, so the turn most likely to need a
    // terminal was the one guaranteed not to get one.
    const h = harness([
      { tool: true, stop: 'tool_use', usage: { inputTokens: 10, outputTokens: 2 }, tookMs: 50 },
      { stop: 'end_turn', usage: { inputTokens: 20, outputTokens: 4 }, tookMs: 40 },
    ]);
    await h.completed;

    const completed = eventsOf(h.announced, 'turn.completed');
    expect(completed.map((e) => e.index)).toEqual([1, 2]);
    expect(completed[0]?.stopReason).toBe('tool_use');
    // The continuation is not an anomaly, so it still costs no diagnostic.
    expect(eventsOf(h.announced, 'diagnostic')).toEqual([]);
    expect(h.candidate?.state.status).toBe('completed');
  });

  it('reports the ending of a turn whose provider sent no usage, carrying none', async () => {
    // The other refusal: `usage` was REQUIRED, so the honest options were a
    // reported number or no event at all. The field is optional now, and the
    // absence is carried as an ABSENCE — `undefined`, never a zero. A zero would
    // be worse than silence, because `SurfaceModel` folds this event's usage into
    // the run's total and would overwrite a real one.
    const h = harness([{ stop: 'end_turn', tookMs: 30 }]);
    await h.completed;

    const completed = eventsOf(h.announced, 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.usage).toBeUndefined();
    expect(completed[0]?.stopReason).toBe('end_turn');
    expect(completed[0]?.durationMs).toBe(30);
    expect(eventsOf(h.announced, 'turn.started')).toHaveLength(1);
    expect(h.candidate?.state.status).toBe('completed');
  });

  it('still never invents a usage — absence stays absence, and zero stays zero', async () => {
    // The invariant that outlives the widening. Making `usage` optional is only
    // safe while the engine passes the provider's value through untouched, so
    // both directions are checked against LITERALS the harness supplied.
    const absent = harness([{ stop: 'end_turn', tookMs: 10 }]);
    await absent.completed;
    // The event must EXIST before its usage can be absent. `[0]?.usage` alone
    // would be `undefined` for a turn that got no terminal at all, so this case
    // would have passed against the OLD refusal for the wrong reason — which is
    // the shape of a guard that looks green while the thing it guards is broken.
    const absentTerminals = eventsOf(absent.announced, 'turn.completed');
    expect(absentTerminals).toHaveLength(1);
    expect(absentTerminals[0]?.usage).toBeUndefined();

    const reportedZero = harness([
      { stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, tookMs: 10 },
    ]);
    await reportedZero.completed;
    // A provider that really said zero is not the same fact as saying nothing,
    // and the payload must be able to tell them apart.
    expect(eventsOf(reportedZero.announced, 'turn.completed')[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});
