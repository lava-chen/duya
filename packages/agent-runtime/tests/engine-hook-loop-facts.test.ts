/**
 * The facts the engine hands a hook, and how OFTEN it hands them over.
 *
 * ## What this file is the proof of
 *
 * Two properties, both load-bearing for the driver flip (S4c deletes the legacy
 * turn loop):
 *
 *  1. **D1 -- the dispatch frequency.** The legacy fires its `PostToolUse` loop
 *     event ONCE PER TURN, guarded by `toolResultMessageCount > 0`
 *     (`DuyaAgent.streamChat`). The engine's `after_tool` phase fires ONCE PER
 *     TOOL RESULT. That is a real behavioural difference, not a rounding error,
 *     and this file pins the ACTUAL count rather than the intent.
 *  2. **D2 -- the streak reaches the hook surface.** The legacy hands its
 *     `PostToolUse` dispatch a `ConsecutiveToolCallStats`; the engine hands every
 *     phase an `ExtensionContext.repeatedToolCalls`, read off the SAME
 *     `RepeatedCallStreak` the anti-dead-loop HARD STOP uses.
 *
 * ## Why every case drives a REAL engine and COUNTS
 *
 * A test asserting that a `stats()` helper returned `{ count: 3 }` would pass
 * against an engine that never called the helper and never dispatched anything.
 * So every case here:
 *
 *  - runs `RunEngineImpl.execute` to completion over scripted ports;
 *  - registers a REAL `ExtensionPort` contributor and records every context it
 *    is handed, so "the hook fired" is an observed count and not an intention;
 *  - counts dispatches AND results separately, because the whole point of D1 is
 *    that those two numbers differ.
 *
 * The un-guarded cases carry `SAFETY_CEILING` far above every threshold here, so
 * a regression that stopped the engine dispatching produces a RED
 * (`max_turns` plus a dispatch count of the ceiling) rather than a hang.
 *
 * ## Where this file lives
 *
 * `packages/agent-runtime/tests/`, alongside `anti-dead-loop-hard-stop.test.ts`,
 * because these cases assert against the same `RunEngineImpl` and reuse its
 * reading of the streak. See that file's "Where these tests live" note: the
 * per-package `tests` include glob is in `vitest.config.ts`, so `npx vitest run
 * packages/agent-runtime` collects this.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ExtensionContext,
  ExtensionPhase,
  ExtensionPort,
  ModelFrame,
  ModelPort,
  RepeatedCallStopPolicy,
  RepeatedToolCallStreak,
  RunEnginePorts,
  RunExecutionRequest,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
import type { RunEvent, RunId, RunManifest } from '@duya/agent-protocol';
import type { EngineRunReport } from '../src/engine/run-engine.js';

// ============================================================================
// Scripted ports
// ============================================================================

/**
 * A ceiling every case carries, far above any threshold asserted here.
 *
 * Its job is to make "the engine stopped early" distinguishable from "the engine
 * ran out of turns": the guarded cases terminate on their own decision, and the
 * unguarded ones reach exactly this many dispatches and report `max_turns`.
 */
const SAFETY_CEILING = 25;

/** One recorded dispatch of one phase. */
interface Seen {
  readonly phase: ExtensionPhase;
  readonly turn: number;
  /** A COPY of the streak, so a later mutation cannot rewrite history. */
  readonly streak: RepeatedToolCallStreak | undefined;
}

interface Harness {
  readonly ports: RunEnginePorts;
  readonly dispatched: readonly ToolCallRequest[];
  readonly seen: readonly Seen[];
  readonly reported: () => { readonly reason: string };
}

const TOOL: ToolDescriptor = { name: 'read', description: 'read a file', inputSchema: {} };

/**
 * A run whose model asks for the tool calls `plan(turn)` names.
 *
 * `tools.dispatch` queues one result per call, so a plan naming three calls in a
 * single turn produces THREE `after_tool` dispatches in that one turn -- which is
 * the case D1 exists to pin.
 */
function harness(
  plan: (turn: number) => readonly ToolCallRequest[],
  reports: EngineRunReport['exit'][],
): Harness {
  const dispatched: ToolCallRequest[] = [];
  const seen: Seen[] = [];
  const queued: ToolDrainItem[] = [];
  let turn = 0;

  const model: ModelPort = {
    async *stream(): AsyncIterable<ModelFrame> {
      turn += 1;
      for (const call of plan(turn)) yield { type: 'tool_use', call };
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model,
    tools: {
      dispatch(call: ToolCallRequest): void {
        dispatched.push(call);
        queued.push({
          kind: 'tool_result',
          callId: call.callId,
          content: `result of ${call.name}`,
          isError: false,
          durationMs: 1,
        });
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const outcome of queued.splice(0, queued.length)) yield outcome;
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
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      authorize: (): Promise<ApprovalVerdict> =>
        Promise.resolve({ allowed: true, scope: 'once' }),
    },
    events: {
      publish(_event: RunEvent): void {},
      proposeTerminal(): void {},
    },
    // The observation point, and a REAL contributor at EVERY phase rather than
    // only `after_tool`: D2's claim is that the streak is on every phase's
    // context, and a source registered for one phase would make "the field is
    // present everywhere" untestable -- an absent phase would be
    // indistinguishable from a phase that was never consulted. It RECORDS rather
    // than asserts, so every count below is read off dispatches the engine
    // really made.
    extensions: {
      list(phase: ExtensionPhase) {
        return [
          {
            id: `probe:${phase}`,
            phase,
            order: 0,
            timeoutMs: 1_000,
            async contribute(context: ExtensionContext): Promise<[]> {
              seen.push({
                phase,
                turn: context.turn,
                streak:
                  context.repeatedToolCalls === undefined
                    ? undefined
                    : { ...context.repeatedToolCalls },
              });
              return [];
            },
          },
        ];
      },
      unload: () => Promise.resolve(),
    } satisfies ExtensionPort,
  };

  return {
    ports,
    dispatched,
    seen,
    reported: () => reports[reports.length - 1] ?? { reason: 'none' },
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const RUN_ID = 'run-1' as RunId;

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
    prompt: { role: 'user', id: 'p1', content: 'read a.txt' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

/** One `read` call. `read_only` so a ledger-less run may dispatch it. */
function readCall(id: string): ToolCallRequest {
  return { callId: id, name: 'read', input: { file_path: 'a.txt' }, sideEffect: 'read_only' };
}

/** N IDENTICAL calls in turn 1 -- same name, same serialised input. */
const N_IDENTICAL_IN_TURN_ONE = (n: number) => {
  return (turn: number): readonly ToolCallRequest[] =>
    turn === 1 ? Array.from({ length: n }, (_unused, index) => readCall(`call-${index + 1}`)) : [];
};

/** The same single call every turn: the stuck-model shape. */
const SAME_CALL_EVERY_TURN = (turn: number): readonly ToolCallRequest[] => [readCall(`call-${turn}`)];

/** Run one execution to completion and return what the ports observed. */
async function run(
  plan: (turn: number) => readonly ToolCallRequest[],
  policy?: RepeatedCallStopPolicy,
): Promise<Harness> {
  const reports: EngineRunReport['exit'][] = [];
  const h = harness(plan, reports);
  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: SAFETY_CEILING,
    onReport: (report) => reports.push(report.exit),
  });
  const controller = new AbortController();
  const request: RunExecutionRequest = {
    manifest: manifestFor(),
    input: inputFor(),
    signal: controller.signal,
    // The conditional spread, not a plain assignment: this package compiles
    // with `exactOptionalPropertyTypes`, so an absent policy has to be an ABSENT
    // policy, which is the state under test.
    ...(policy === undefined ? {} : { repeatedCallStop: policy }),
    ports: h.ports,
  };
  await engine.execute(request).completed();
  return h;
}

// ============================================================================
// D1 -- the dispatch frequency, pinned by counting
// ============================================================================

describe('how often the engine hands a hook the tool phase', () => {
  it('dispatches after_tool once per RESULT, so three results in one turn fire three times', async () => {
    // THE COUNT. The legacy fires its `PostToolUse` loop event once for this
    // exact turn (`toolResultMessageCount > 0` is a boolean gate); the engine
    // fires three times. Asserting the COUNT rather than "> 0" is what makes a
    // per-turn implementation of this slice fail: it would produce 1 here.
    const h = await run(N_IDENTICAL_IN_TURN_ONE(3));

    const afterTool = h.seen.filter((entry) => entry.phase === 'after_tool');
    expect(afterTool).toHaveLength(3);
    // Every one of them in the SAME turn, which is what "per result" means and
    // what a per-turn implementation cannot produce.
    expect(afterTool.map((entry) => entry.turn)).toEqual([1, 1, 1]);
    // Cross-check against the dispatch count: the phase fired once per call the
    // engine actually dispatched, not once per drain batch.
    expect(h.dispatched).toHaveLength(3);
  });

  it('dispatches after_tool once for a single-result turn, matching the legacy for that shape', async () => {
    // The common case, and the one where the two paths AGREE. Pinning it stops
    // the difference above from being mistaken for "the engine always fires
    // more": one result in a turn is one dispatch on both sides.
    const h = await run(SAME_CALL_EVERY_TURN, { enabled: false, hardStopAt: 99 });

    const afterTool = h.seen.filter((entry) => entry.phase === 'after_tool');
    // 25 turns each dispatching one call; the ceiling is what ends the run.
    expect(h.dispatched).toHaveLength(SAFETY_CEILING);
    expect(afterTool).toHaveLength(SAFETY_CEILING);
    expect(h.reported().reason).toBe('max_turns');
  });

  it('delivers the turn\'s FINAL streak to each of the turn\'s after_tool dispatches', async () => {
    // MEASURED, and it contradicts the obvious assumption.
    //
    // Every call in a turn is DISPATCHED before the drain runs, and
    // `RepeatedCallStreak.record` happens on the way out of `#dispatchCall`. So
    // by the time the first result reaches `after_tool`, the streak already
    // counts the WHOLE turn: this reads [3, 3, 3], not [1, 2, 3].
    //
    // It matters because a nudge hook compares for EQUALITY
    // (`count === nudgeAt`, `hooks/builtin.ts`). Under the legacy's per-turn
    // dispatch that predicate can match once per turn; here it can match once per
    // tool RESULT in that turn. The consequence is stated in `hook-source.ts`
    // and in the report rather than designed away, because the alternative --
    // firing `after_tool` per turn -- cannot supply the per-call `tool_name` /
    // `tool_response` / `tool_use_id` that `PostToolUseHookInputSchema` requires
    // or that `ConfigHooksRunner`'s `toolName` matcher filters on.
    const h = await run(N_IDENTICAL_IN_TURN_ONE(3));

    const counts = h.seen
      .filter((entry) => entry.phase === 'after_tool')
      .map((entry) => entry.streak?.count);
    expect(counts).toEqual([3, 3, 3]);
  });
});

// ============================================================================
// D2 -- the streak, from the SAME counter the hard stop uses
// ============================================================================

describe('the streak a hook is handed', () => {
  it('is absent before the run has dispatched anything, rather than a zero', async () => {
    // `on_start` runs before turn 1, so there is nothing recorded yet. The legacy
    // answers the same question with `undefined` (`DeadLoopTracker.stats`), and a
    // fabricated `count: 0` would be a claim that the model repeated a call zero
    // times -- which reads as "no streak" only by accident, and as "a streak of
    // length zero" to a hook that compares against a threshold.
    const h = await run(N_IDENTICAL_IN_TURN_ONE(1));

    const onStart = h.seen.filter((entry) => entry.phase === 'on_start');
    expect(onStart).toHaveLength(1);
    expect(onStart[0]?.streak).toBeUndefined();
    // And the field really was consulted at that phase: the run dispatched a
    // call later, so an absent streak here is a fact and not a missing hook.
    expect(h.dispatched).toHaveLength(1);
  });

  it('names the tool in the streak, and every after_tool of a turn reads the same count', async () => {
    const h = await run(N_IDENTICAL_IN_TURN_ONE(3));

    const streaks = h.seen
      .filter((entry) => entry.phase === 'after_tool')
      .map((entry) => entry.streak);
    expect(streaks).toEqual([
      { count: 3, toolName: 'read' },
      { count: 3, toolName: 'read' },
      { count: 3, toolName: 'read' },
    ]);
  });

  it('resets to 1 when the model changes the call, exactly as the hard stop counts it', async () => {
    // The sharper half of "the two sides agree": a streak that merely counted up
    // would pass the three-identical-calls case above. A DIFFERENT tool must
    // restart it, and the number the hook sees must be the number the guard uses
    // -- proved below by the guard never firing on a plan whose hook-visible count
    // never exceeds 1.
    const alternating = (turn: number): readonly ToolCallRequest[] => [
      { callId: `call-${turn}-a`, name: 'read', input: { file_path: 'a.txt' }, sideEffect: 'read_only' },
      { callId: `call-${turn}-b`, name: 'list', input: { dir: '.' }, sideEffect: 'read_only' },
    ];
    const h = await run(alternating, { enabled: true, hardStopAt: 3 });

    // `read` then `list` restarts the streak every turn, so it can never reach 3.
    expect(h.reported().reason).toBe('max_turns');
    // Two calls per turn for the whole ceiling -- so the run really did dispatch
    // fifty calls, and "the guard did not fire" is not "the run did little".
    expect(h.dispatched).toHaveLength(SAFETY_CEILING * 2);
    const counts = h.seen
      .filter((entry) => entry.phase === 'after_tool')
      .map((entry) => entry.streak?.count);
    expect(counts).toHaveLength(SAFETY_CEILING * 2);
    // Narrowed rather than asserted away: every `after_tool` in this run follows a
    // dispatch, so an absent streak at any of them is a defect and would make
    // `Math.max` read `undefined` and pass by accident.
    expect(counts.every((count) => count !== undefined)).toBe(true);
    expect(Math.max(...(counts as number[]))).toBe(1);
  });

  it('is on EVERY phase context, including the run-scoped ones', async () => {
    // D2's claim is deliberately broader than "the nudge hook can see it". A
    // `before_finalize` contributor deciding whether to veto has the same
    // interest in the evidence, and `after_finalize` on a `repeated_tool_calls`
    // exit is handed the very count that stopped the run.
    const h = await run(SAME_CALL_EVERY_TURN, { enabled: true, hardStopAt: 3 });

    const phases = new Set(h.seen.map((entry) => entry.phase));
    // `before_finalize` is consulted on the turn the run stops, so it is reached.
    expect(phases.has('before_finalize')).toBe(true);
    expect(phases.has('after_finalize')).toBe(true);

    const afterFinalize = h.seen.filter((entry) => entry.phase === 'after_finalize');
    expect(afterFinalize).toHaveLength(1);
    // The stop fired at 3, and the last phase saw the same 3. ONE counter: these
    // two numbers come from the same object, and this assertion is what would go
    // red if a second counter were introduced.
    expect(afterFinalize[0]?.streak).toEqual({ count: 3, toolName: 'read' });
    expect(h.reported().reason).toBe('repeated_tool_calls');
    // And the engine really did dispatch that many calls, so `count: 3` is a
    // measurement of three dispatches rather than a counter that ran ahead.
    expect(h.dispatched).toHaveLength(3);
  });

  it('reaches a before_tool contributor, EXCLUDING the call it precedes', async () => {
    // MEASURED, and the order is load-bearing: `#dispatchCall` runs
    // `#contribute('before_tool')` FIRST and only then
    // `repeatedCalls.record(...)` on its way out. So a `before_tool` hook is
    // asked "how many identical calls had ALREADY been made", and the answer for
    // the first call of a run is `undefined`.
    //
    // Stated as its own case because it is the one place the field's meaning is
    // not "including the current call", and an implementer who assumed symmetry
    // with `after_tool` would get an off-by-one they could not see.
    const h = await run(N_IDENTICAL_IN_TURN_ONE(3));

    const beforeTool = h.seen.filter((entry) => entry.phase === 'before_tool');
    expect(beforeTool).toHaveLength(3);
    expect(beforeTool.map((entry) => entry.streak?.count)).toEqual([undefined, 1, 2]);
  });
});
