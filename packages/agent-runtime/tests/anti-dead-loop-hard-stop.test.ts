/**
 * The anti-dead-loop HARD STOP, as an invariant of the engine's own loop.
 *
 * ## What this file is the proof of
 *
 * The capability lives today in one place only:
 * `packages/agent/src/agent/TurnLoopTracker.ts` counts consecutive identical
 * tool calls and the legacy loop reads `shouldHardStop()` at the top of every
 * turn (`DuyaAgent.ts:4271`). Deleting that loop in a later slice must not
 * delete the capability, so the invariant moved onto `RunEngineImpl` with the
 * threshold supplied by the host through `RunExecutionRequest.repeatedCallStop`.
 *
 * The legacy is untouched and still drives every production run, so none of this
 * is live yet. What these tests pin is the SEAM: that the engine stops, that it
 * stops for the host's number, and that nothing else decides it.
 *
 * ## Why every case here drives a real engine
 *
 * A test that asserted a helper returned `true` would pass against an engine
 * that never called the helper. So each case runs `RunEngineImpl.execute` to
 * completion over scripted ports and counts what the PORTS observed:
 *
 *  - **every case carries a turn ceiling far above the threshold.** That ceiling
 *    is what makes the suite terminate, so a regression that stops the invariant
 *    firing produces a RED result (`max_turns`, and a dispatch count of 25)
 *    rather than a hang. A guard whose absence is indistinguishable from a
 *    timeout is a guard with no test.
 *  - **every case counts dispatches.** Not zero and not N+1: a run that never
 *    reached the loop cannot pass, and a run that stopped one call late cannot
 *    either.
 *
 * ## Two independent sources for the outcome
 *
 * The stop reason is read twice: from the terminal CANDIDATE the engine proposed
 * through the events port, and from `RunEngineOptions.onReport`'s `exit`. Those
 * are different call sites reporting the same fact, so a `#terminalCandidate`
 * that rewrote the reason would disagree with the run that produced it.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  CompactionPort,
  ModelFrame,
  ModelPort,
  RepeatedCallStopPolicy,
  RunEnginePorts,
  RunExecutionRequest,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
  TurnOutputPort,
} from '../src/engine/ports.js';
import type { RunEvent, RunId, RunManifest } from '@duya/agent-protocol';
import type { EngineRunReport } from '../src/engine/run-engine.js';

// ============================================================================
// The two ports this file does not test, bound to their smallest honest answer
// ============================================================================

/** "This harness records nothing." A durable-rows proof lives elsewhere. */
const NO_TURNOUTPUT: TurnOutputPort = {
  recordToolResult: () => Promise.resolve(),
  recordAssistantMessage: () => Promise.resolve(),
  finishTurn: () => Promise.resolve(),
  recordInjectedMessage: () => Promise.resolve(),
};

/** "This harness never compacts." A replacement proof lives elsewhere. */
const NO_COMPACTION: CompactionPort = {
  decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test here' }),
  run: () => Promise.resolve({ kind: 'declined', reason: 'not under test here' }),
  nextCompactionId: () => 'cmp-adl',
};

// ============================================================================
// Scripted ports
// ============================================================================

/**
 * A ceiling every case carries, chosen so it can never be the reason a
 * threshold-shaped assertion passes.
 *
 * The lowest threshold any case arms is 3, so a run that reached 25 turns
 * dispatched 25 calls and reported `max_turns`: proof by exhaustion that the
 * invariant, not the ceiling, is what stopped the guarded cases.
 */
const SAFETY_CEILING = 25;

interface Harness {
  readonly ports: RunEnginePorts;
  /** Tool calls the engine actually dispatched, in order. */
  readonly dispatched: readonly ToolCallRequest[];
  /** Terminal candidates the engine proposed. */
  readonly terminal: () => { readonly status: string; readonly reason: string };
  /** What `onReport` was told, which is a different call site than the above. */
  readonly reported: () => { readonly reason: string };
}

/**
 * A run whose model asks for `plan(turn)` on every turn.
 *
 * Returning `[]` is a turn that requested no tool, which is the ordinary way a
 * scripted run ends -- so a case that must NOT hard-stop has a way to finish
 * without a ceiling ending it for it.
 */
function harness(
  plan: (turn: number) => readonly ToolCallRequest[],
  reports: EngineRunReport['exit'][],
): Harness {
  const dispatched: ToolCallRequest[] = [];
  const queued: ToolDrainItem[] = [];
  const terminals: { status: string; reason: string }[] = [];
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
    // Plan 610 D4: required since the flip. Neither is under test here, so both
    // are bound to the smallest honest answer -- "records nothing" and "skips"
    // -- rather than omitted. The two call sites they own (`TurnOutputPort`'s
    // durable rows, `CompactionPort`'s transcript replacement) have dedicated
    // proofs; this file is about the repeated-call invariant.
    turnOutput: NO_TURNOUTPUT,
    compaction: NO_COMPACTION,
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
      describe: (): readonly ToolDescriptor[] => [
        { name: 'read', description: 'read a file', inputSchema: {} },
      ],
    },
    context: {
      assemble: (): Promise<AssembledTurn> =>
        Promise.resolve({
          systemPrompt: 'you are a test',
          messages: [],
          tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
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
      proposeTerminal(candidate): void {
        terminals.push({ status: candidate.state.status, reason: candidate.reason });
      },
    },
  };

  return {
    ports,
    dispatched,
    terminal: () => terminals[terminals.length - 1] ?? { status: 'none', reason: 'none' },
    reported: () => reports[reports.length - 1] ?? { reason: 'none' },
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const RUN_ID = 'run-1' as RunId;

/** The same call, every turn. This is what a stuck model emits. */
const SAME_CALL_EVERY_TURN = (turn: number): readonly ToolCallRequest[] => [
  {
    callId: `call-${turn}`,
    name: 'read',
    input: { file_path: 'a.txt' },
    // `read_only` so a run with no side-effect ledger may still dispatch it:
    // `#ticket` refuses every other class when the ledger is absent.
    sideEffect: 'read_only',
  },
];

/** Two calls that differ by NAME, alternating -- a streak of one forever. */
const ALTERNATING_NAMES = (turn: number): readonly ToolCallRequest[] => [
  {
    callId: `call-${turn}`,
    name: turn % 2 === 1 ? 'read' : 'list',
    input: { file_path: 'a.txt' },
    sideEffect: 'read_only',
  },
];

/** One name, two different inputs -- also a streak of one, and the sharper test. */
const ALTERNATING_INPUTS = (turn: number): readonly ToolCallRequest[] => [
  {
    callId: `call-${turn}`,
    name: 'read',
    input: { file_path: turn % 2 === 1 ? 'a.txt' : 'b.txt' },
    sideEffect: 'read_only',
  },
];

/** Stop asking for tools after `identicalCalls` of them, then finish normally. */
const identicalThenFinish = (identicalCalls: number) => {
  return (turn: number): readonly ToolCallRequest[] =>
    turn <= identicalCalls ? SAME_CALL_EVERY_TURN(turn) : [];
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
    prompt: { role: 'user', id: 'p1', content: 'read a.txt' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

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
    // with `exactOptionalPropertyTypes`, so naming the field with an
    // `undefined` value is not the same as omitting it. An absent policy has to
    // be an ABSENT policy, because that is the state under test.
    ...(policy === undefined ? {} : { repeatedCallStop: policy }),
    ports: h.ports,
  };
  await engine.execute(request).completed();
  return h;
}

// ============================================================================
// Acceptance 1 -- the engine stops, and only for the host's reason
// ============================================================================

describe('the engine hard-stops a repeated tool call streak', () => {
  it('stops at the host-supplied threshold, having dispatched exactly that many calls', async () => {
    const h = await run(SAME_CALL_EVERY_TURN, { enabled: true, hardStopAt: 3 });

    // THE POSITIVE PROOF. Not "a helper said true": a real engine ran 25 turns
    // worth of budget, dispatched exactly the three calls the host asked it to
    // tolerate, and stopped on its own decision.
    expect(h.dispatched).toHaveLength(3);
    expect(h.dispatched.map((call) => call.name)).toEqual(['read', 'read', 'read']);
    expect(h.reported().reason).toBe('repeated_tool_calls');
    expect(h.terminal().reason).toBe('the run stopped because the model repeated the same tool call');
    // `completed`, not `failed`: the guardrail doing its job is not an error,
    // and every call before the stop was dispatched, recorded and settled.
    expect(h.terminal().status).toBe('completed');
  });

  it('stops one turn LATER when the host asks for a higher threshold', async () => {
    // Criterion: the threshold is READ, not remembered. The only thing that
    // changed between this run and the one above is the number in the policy.
    const h = await run(SAME_CALL_EVERY_TURN, { enabled: true, hardStopAt: 5 });

    expect(h.dispatched).toHaveLength(5);
    expect(h.reported().reason).toBe('repeated_tool_calls');
  });

  it('does not stop BELOW the threshold, and finishes normally instead', async () => {
    // Two identical calls is a streak of two, and the host said three.
    const h = await run(identicalThenFinish(2), { enabled: true, hardStopAt: 3 });

    expect(h.dispatched).toHaveLength(2);
    expect(h.reported().reason).toBe('completed');
  });

  it('does not stop when the calls are not identical by name', async () => {
    // Unbounded repetition of two DIFFERENT calls is not a stuck model, so the
    // guard must never fire; the safety ceiling is what ends this run, and the
    // reason it reports is the proof it was the ceiling.
    const h = await run(ALTERNATING_NAMES, { enabled: true, hardStopAt: 3 });

    expect(h.dispatched).toHaveLength(SAFETY_CEILING);
    expect(h.reported().reason).toBe('max_turns');
  });

  it('does not stop when the calls are not identical by input', async () => {
    // The sharper of the two, because name alone is too easy to satisfy: the
    // streak counts name AND serialised input, so a model that varies either
    // has not repeated itself.
    const h = await run(ALTERNATING_INPUTS, { enabled: true, hardStopAt: 3 });

    expect(h.dispatched).toHaveLength(SAFETY_CEILING);
    expect(h.reported().reason).toBe('max_turns');
  });

  it('does not stop when the guard is disabled', async () => {
    const h = await run(SAME_CALL_EVERY_TURN, { enabled: false, hardStopAt: 3 });

    expect(h.dispatched).toHaveLength(SAFETY_CEILING);
    expect(h.reported().reason).toBe('max_turns');
  });

  it('arms nothing when the host supplies no policy at all', async () => {
    // No default threshold. A guard that appeared on its own would be a ceiling
    // no host agreed to, enforced on every run in the product and recorded
    // nowhere -- and this run's 25 dispatches are what that would have hidden.
    const h = await run(SAME_CALL_EVERY_TURN);

    expect(h.dispatched).toHaveLength(SAFETY_CEILING);
    expect(h.reported().reason).toBe('max_turns');
  });
});