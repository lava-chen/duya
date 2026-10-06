/**
 * `InterTurnInputPort` — the host may inject input between turns.
 *
 * ## What these tests are for
 *
 * The port is REQUIRED on `RunEnginePorts` precisely because its absence would
 * be invisible: an engine that skipped the sweep would call the model, dispatch
 * tools, propose a clean `completed` terminal and publish every frame
 * correctly, while the user's mid-run correction never reached the model. There
 * is no missing frame for a consumer to notice, because a skipped sweep
 * publishes nothing at all.
 *
 * So these tests cannot be "the port is wired" assertions. Each one pins a
 * specific thing that becomes observably wrong if the engine stops honouring
 * the sweep's answer, and each was seen RED with that behaviour removed before
 * being accepted (see the mutation notes on each case).
 *
 * ## What is deliberately NOT asserted here
 *
 * That the engine can be built without the port. That is a COMPILE-time
 * property, asserted in `src/engine/port-guards.ts` where
 * `npm run typecheck:runtime` can see it — this package's tsconfig excludes
 * `test/`, so a type assertion written here would be checked by nothing.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  InterTurnDecision,
  InterTurnInputPort,
  InterTurnSweep,
  InterTurnSweepResult,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEvent,
  RunExecutionRequest,
  ToolDescriptor,
  ToolDrainItem,
} from '../src/engine/ports.js';

const MANIFEST = {
  runId: 'run-inter-turn',
  sessionId: 'sess-1',
  seq: 0,
  origin: { kind: 'user' },
  manifestHash: 'h',
  agent: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
} as unknown as RunExecutionRequest['manifest'];

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'do the thing' },
  history: { kind: 'inline', value: [] as readonly ModelMessage[] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'inline', value: [] as readonly ToolDescriptor[] },
  steering: [],
  options: {},
} as unknown as RunExecutionRequest['input'];

const ASSEMBLED: AssembledTurn = {
  systemPrompt: 'sys',
  messages: [],
  tools: [],
  catalogRevision: 'c',
  revision: 'r',
};

/** Nothing queued. The overwhelmingly common answer. */
const NOTHING: InterTurnSweepResult = {
  decision: { action: 'continue', absorbed: false },
  injected: [],
};

interface Script {
  /** The answer for each sweep, in order. The last one repeats forever. */
  readonly answers: readonly InterTurnDecision[];
  /** Messages each absorbing sweep injects, by sweep index. */
  readonly injected?: readonly (readonly ModelMessage[])[];
}

interface Run {
  readonly sweeps: readonly InterTurnSweep[];
  readonly requests: readonly (readonly ModelMessage[])[];
  readonly exit: string;
}

/**
 * Drive a real engine over a scripted model and a scripted inter-turn port.
 *
 * The model answers `end_turn` with no tool calls, so the run reaches the stop
 * decision every turn — which is the only place the `before_final_answer`
 * sweeps fire. Nothing about the port is hand-fed: the decision and the
 * injected messages are read off the actual objects the engine used.
 */
async function run(script: Script, maxTurns = 6): Promise<Run> {
  const sweeps: InterTurnSweep[] = [];
  const requests: ModelMessage[][] = [];
  let sweepCount = 0;

  const interTurn: InterTurnInputPort = {
    async sweep(input: InterTurnSweep): Promise<InterTurnSweepResult> {
      sweeps.push(input);
      const index = sweepCount;
      sweepCount += 1;
      const decision = script.answers[index] ?? { action: 'continue', absorbed: false };
      return {
        decision,
        injected: decision.action === 'continue' && decision.absorbed
          ? (script.injected?.[index] ?? [])
          : [],
      };
    },
  };

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      requests.push([...request.messages]);
      yield { type: 'text', text: `answer ${requests.length}` };
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const events: RunEvent[] = [];
  const ports: RunEnginePorts = {
    model,
    interTurn,
    tools: {
      dispatch: () => {},
      drain: () => (async function* (): AsyncIterable<ToolDrainItem> {})(),
      discard: () => {},
      describe: () => [],
    },
    context: { assemble: () => Promise.resolve(ASSEMBLED), defer: () => {} },
    approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as ApprovalVerdict) },
    events: { publish: (event) => void events.push(event), proposeTerminal: (candidate) => void candidates.push(candidate) },
  };
  const candidates: { state: { status: string } }[] = [];

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: maxTurns });
  await engine
    .execute({ manifest: MANIFEST, input: INPUT, signal: new AbortController().signal, ports })
    .completed();

  return { sweeps, requests, exit: candidates[0]?.state.status ?? 'none' };
}

const text = (id: string, body: string): ModelMessage => ({ role: 'user', id, content: body });
const ids = (messages: readonly ModelMessage[]): string[] => messages.map((m) => m.id);

describe('the engine asks the host before the model call', () => {
  it('sweeps at before_model_turn, naming the run', async () => {
    // MUTATION NOTE: removing the pre-model sweep makes `sweeps` empty and this
    // fails. The checkpoint NAME is asserted too, because the host filters
    // claimable rows by it — a sweep arriving under the wrong name claims
    // nothing and reports nothing.
    //
    // Asserted as an EXACT object, not a subset, because the contract carries no
    // turn number: `InterTurnSweep` has exactly two members and a third would
    // be a field with no reader (`ports.ts` says why at the type).
    const { sweeps } = await run({ answers: [{ action: 'continue', absorbed: false }] });

    expect(sweeps[0]).toEqual({
      runId: 'run-inter-turn',
      checkpoint: 'before_model_turn',
    });
  });

  it('carries what the host injected into the request it is about to send', async () => {
    // MUTATION NOTE: dropping `injected` (assigning instead of appending, or
    // not calling `#absorbInjection`) makes `ids(requests[0])` lack the injected
    // id and this fails.
    const { requests } = await run({
      answers: [{ action: 'continue', absorbed: true }],
      injected: [[text('injected:steer', 'actually, use the other approach')]],
    });

    expect(ids(requests[0] ?? [])).toContain('injected:steer');
  });

  it('ACCUMULATES injections, so a later one does not overwrite an earlier one', async () => {
    // The test that separates "append" from "assign", and the only one that does.
    // Every other case here injects at most once, and for a single injection
    // `[...current, ...new]` and `= new` are the same value -- so an
    // implementation that assigned would pass all of them. This one injects at
    // two different sweeps and asserts the THIRD request still carries the first.
    //
    // A run that absorbed a turn-2 notification and a turn-4 steering correction
    // and then showed the model only the correction is the silent data loss the
    // run-scoped cell exists to prevent.
    //
    // MUTATION NOTE: replacing the append with an assignment makes request 3
    // carry `injected:second` and NOT `injected:first`, and this fails.
    const { requests } = await run({
      answers: [
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: false },
        { action: 'continue', absorbed: false },
        { action: 'continue', absorbed: false },
      ],
      injected: [
        [text('injected:first', 'the earlier one')],
        [],
        [text('injected:second', 'the later one')],
      ],
    });

    expect(requests.length).toBeGreaterThanOrEqual(3);
    const last = ids(requests[requests.length - 1] ?? []);
    expect(last).toContain('injected:first');
    expect(last).toContain('injected:second');
  });

  it('keeps the injection on LATER turns too, because it edited the transcript', async () => {
    // The property that distinguishes an injection from a per-request fragment.
    // MUTATION NOTE: holding the injected list per-turn rather than run-scoped
    // makes turn 2's request lack the id and this fails — and the failure is
    // invisible in a single-turn run, which is why it is asserted on turn 2.
    //
    // The second turn is forced by an ABSORBING answer at the stop decision, not
    // by a tool call: an absorption at `before_model_turn` does not loop, it only
    // injects, so the loop-back has to come from sweep index 1.
    const { requests } = await run({
      answers: [
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: false },
        { action: 'continue', absorbed: false },
      ],
      injected: [[text('injected:steer', 'correction')]],
    });

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(ids(requests[1] ?? [])).toContain('injected:steer');
  });
});

describe('a sweep around the final answer can keep the run open', () => {
  it('asks at before_final_answer once the model has stopped asking for work', async () => {
    // MUTATION NOTE: removing the stop-decision sweep leaves only the pre-model
    // sweep, so no `before_final_answer` entry exists and this fails.
    const { sweeps } = await run({ answers: [{ action: 'continue', absorbed: false }] });

    expect(sweeps.map((s) => s.checkpoint)).toContain('before_final_answer');
  });

  it('an absorbing answer loops back for another turn instead of finishing', async () => {
    // MUTATION NOTE: treating an absorbing `continue` as "stop" (dropping the
    // `return null`) ends the run after one request, so `requests.length` is 1
    // and this fails.
    const { requests, exit } = await run({
      answers: [
        { action: 'continue', absorbed: false },
        { action: 'continue', absorbed: true },
        { action: 'continue', absorbed: false },
      ],
    });

    expect(requests.length).toBe(2);
    expect(exit).toBe('completed');
  });

  it('a hard_replace also loops back, because the host replaced the context', async () => {
    // MUTATION NOTE: treating `hard_replace` as a stop ends the run after one
    // request and this fails.
    const { requests } = await run({
      answers: [
        { action: 'continue', absorbed: false },
        { action: 'hard_replace', replacement: '<runtime_context/>' },
        { action: 'continue', absorbed: false },
      ],
    });

    expect(requests.length).toBe(2);
  });

  it('a soft_stop ends the run instead of spending another model call', async () => {
    // MUTATION NOTE: ignoring `soft_stop` and falling through to the model makes
    // `requests.length` 1 but then loops (it consults the sweep again), so the
    // turn count and the exit both move; the assertion below is on the COUNT of
    // model calls, which is the thing a soft stop exists to avoid.
    const { requests, exit } = await run({
      answers: [
        { action: 'continue', absorbed: false },
        { action: 'soft_stop', summary: 'stopped as requested' },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(exit).toBe('completed');
  });

  it('the finalize POLL is bounded, so a host that always has news cannot hold the run open', async () => {
    // The bound is on the POLL, not on the first stop-decision sweep, and that
    // asymmetry is the legacy's own: `DuyaAgent.ts:3211-3213` loops on an
    // absorbing answer with no cap, while the finalize poll is capped at
    // `FINAL_POLL_MAX_ABSORBS` (`:1819`, `:3262`). Asserting the cap on the
    // wrong one of the two would pass against a regression in the other.
    //
    // So the script answers FALSE, FALSE, TRUE in a cycle: no absorption at the
    // pre-model sweep, none at the first stop sweep, absorption at the POLL.
    // MUTATION NOTE: raising or removing the bound lets a fourth absorb through
    // and `requests.length` becomes 5, failing the exact-count assertion below.
    const cycle = [
      { action: 'continue', absorbed: false },
      { action: 'continue', absorbed: false },
      { action: 'continue', absorbed: true },
    ];
    const { requests } = await run({ answers: [...cycle, ...cycle, ...cycle, ...cycle] });

    // Three absorbs (the legacy's cap) plus the turn they were spent on.
    expect(requests.length).toBe(4);
  });
});

describe('a host with nothing queued is a first-class answer', () => {
  it('completes in one turn without looping, and still sweeps', async () => {
    // MUTATION NOTE: if an empty result were read as "absorbed" the run would
    // loop forever, and if the sweep were skipped entirely `sweeps` would be
    // empty. Both fail here.
    const { sweeps, requests, exit } = await run({ answers: [{ action: 'continue', absorbed: false }] });

    expect(requests).toHaveLength(1);
    expect(sweeps.length).toBeGreaterThan(0);
    expect(exit).toBe('completed');
  });
});
