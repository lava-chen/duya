/**
 * Plan 610 slice A4, step 4 of `04-runtime-owns-execution.md`: the six
 * scenarios, driven against `RunEngineImpl` -- the component that will own the
 * product turn after the A3 cutover.
 *
 * ## Why this file exists at all
 *
 * Plan 600 `04` section 0 is the reason. It records that the OLD acceptance
 * gate could be satisfied by wrapping `DuyaAgent.streamChat` in an
 * `ExecutionChannel` while the loop stayed exactly where it was, and that
 * `headless-run-host.ts:26` is that shape in this repository today. So "the
 * engine can be called" proves nothing, and a suite of engine tests proves
 * nothing about the PRODUCT turn, which is still the legacy generator and is
 * not connected to any of this.
 *
 * The A3 cutover is all-or-nothing: `ports.ts` records that binding the output
 * ports while the legacy still drives performs every side effect twice, so the
 * flip cannot be done in reversible steps. The only thing that makes a one-shot
 * flip defensible is having ALREADY proven, against the engine, that the engine
 * handles these six scenarios. A scenario testable only after the cutover is a
 * scenario that has never been tested.
 *
 * `packages/agent/tests/unit/agent/turn-loop-product-behavior.test.ts` is the
 * product-level safety net that already exists, and it drives the LEGACY
 * driver. This file is its engine-level counterpart: the same six scenarios,
 * the same shape of assertion, against the driver that will replace it.
 *
 * ## The two rules every test here is built to satisfy
 *
 * **1. Reject trivial identities.** Every assertion compares two INDEPENDENT
 * sources. The marker a scripted tool producer returned is one; the text the
 * model port was actually invoked with is another; the row the ledger port was
 * actually asked to write is a third. Nothing here compares a measured value
 * against itself, and nothing derives an expectation by re-running the code
 * under test.
 *
 * **2. A count of zero is not a pass.** `expect(results).toHaveLength(0)` is
 * satisfied just as happily by an engine that never ran, so every scenario also
 * asserts POSITIVE evidence that the interesting path was taken -- the tool was
 * dispatched, the drain was entered, the model was called the expected number
 * of times. The cancellation and slow-consumer cases are the ones where this
 * matters most: a "cancelled" test in which nothing was in flight to begin with
 * would pass against an engine that ignores cancellation entirely.
 *
 * Each scenario names the MIS-IMPLEMENTATION it is proven against in its own
 * `describe` block, and every one of those mutations was actually injected and
 * observed to turn this suite red before being reverted. The counts are in the
 * slice report; the mechanism is recorded here so a future reader can re-run it
 * rather than trust it.
 *
 * ## What these tests do NOT claim
 *
 * They are not E2E. There is no provider key, no Electron host, no renderer and
 * no real worker process in this environment, so nothing here shows a real
 * socket dying on abort, a real SQLite row refusing a write, or a real UI
 * stalling. What is shown is that the ENGINE reaches the right decision on each
 * scenario, given a port that reports the scenario faithfully.
 *
 * `engine-scenario-slow-consumer.test.ts` is separate because that scenario
 * needs a real `BoundedEventQueue` and a real emitter rather than recorders.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  SubtaskTerminationReason,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  ToolResultRecord,
  ToolSideEffectLedger,
  TransientContextFragment,
  TurnOutputSummary,
} from '../src/engine/ports.js';
import type { RunEvent, RunFence, RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-a4' as RunId;

// ============================================================================
// Sentinels
//
// Each is a string the TEST chose and the ENGINE could not have guessed. Every
// assertion that uses one compares it against something the engine produced
// through a different port, which is what keeps the comparison cross-source.
// ============================================================================

/** What the tool "returned". Written by the producer, read off the model request. */
const TOOL_ANSWER = 'TOOL-ANSWER-a41f9c2';
/** The failure text a tool produced, for the tool-error scenario. */
const TOOL_FAILURE = 'TOOL-FAILURE-7d0e13: the write was refused';
/** One answer per turn, so a re-sent fragment is distinguishable from a first send. */
function answerFor(turn: number): string {
  return `${TOOL_ANSWER}-turn${turn}`;
}

// ============================================================================
// The harness
//
// Recorders, not mocks: every port KEEPS what it was handed, so an expectation
// is read off the engine's own calls rather than off a re-derivation of them.
// ============================================================================

/** One scripted model call. `endsOpen` scripts a stream that dies mid-flight. */
interface ScriptedTurn {
  readonly frames: readonly ModelFrame[];
  /** Omit the closing frame, or throw, to script a transport that dies. */
  readonly diesWith?: Error;
}

interface ToolScript {
  /**
   * The call this script answers.
   *
   * Matched by `callId` and NOT by name, because a multi-turn test needs three
   * scripts for three calls to the SAME tool and a name lookup would hand every
   * dispatch the first script's answer. That mistake makes the "delivered once"
   * assertion pass or fail for the wrong reason, which is the kind of false
   * green this suite exists to rule out.
   */
  readonly callId: string;
  readonly name: string;
  /** What the producer hands back as the result content. */
  readonly answer: string;
  /** Stated failure, tri-state exactly as `ToolOutcome.isError` defines it. */
  readonly isError?: boolean;
  /** Park the drain until this resolves, so an abort can land while it is open. */
  readonly drainGate?: Promise<void>;
  /** Queue the result for a LATER drain than the one this dispatch opens. */
  readonly deliverOnTurn?: number;
}

interface HarnessOptions {
  readonly turns: readonly ScriptedTurn[];
  readonly tools?: readonly ToolScript[];
  /** Refuse every approval. */
  readonly denyApproval?: boolean;
  /** Attach a lease store, so a worker-exit claim can be about RECOVERY. */
  readonly lease?: boolean;
  /** Attach a subtask registry, so the sweep is observable. */
  readonly subtasks?: boolean;
  /** Reject the named host write. `turn` is the TurnOutputPort; `settle` the ledger. */
  readonly rejectWrite?: 'recordToolResult' | 'finishTurn' | 'settle' | 'assemble';
  /**
   * An EXISTING lease store, so a second attempt can be run against the same
   * durable store as the first.
   *
   * This is the whole point of the worker-exit recovery claim, and a fresh store
   * per run would quietly destroy it: two independent stores each number their
   * first attempt epoch 1, so "the new attempt has a strictly newer epoch" would
   * be unfalsifiable. One store, one run, two attempts.
   */
  readonly leaseStore?: LeaseStore;
}

interface Harness {
  readonly ports: RunEnginePorts;
  /** Ordered log of every port interaction, e.g. `model.stream:1`. */
  readonly log: string[];
  /** Calls the engine actually dispatched, in order. */
  readonly dispatched: ToolCallRequest[];
  /** Every event the engine offered the port, in order. */
  readonly events: RunEvent[];
  /** Terminal candidates the engine proposed. */
  readonly terminals: { state: { status: string; error?: { message: string } }; reason: string }[];
  /** Ledger rows, in the order the ledger was asked to write them. */
  readonly ledger: string[];
  /** Records the engine handed `TurnOutputPort.recordToolResult`. */
  readonly records: ToolResultRecord[];
  /** Summaries the engine handed `TurnOutputPort.finishTurn`. */
  readonly summaries: TurnOutputSummary[];
  /** Messages the model was actually invoked with, one entry per turn. */
  readonly sentMessages: ModelMessage[][];
  /** Subtask sweeps, as `reason:includeDetached`. */
  readonly sweeps: string[];
  /** The attempt leases acquired, and the fences released. */
  readonly leases: LeaseStore;
  /** How many times the drain was ENTERED, which is not the same as how many items it yielded. */
  drainEntries(): number;
  /** How many times a tool was actually executed by the scripted producer. */
  toolRuns(): number;
  /** Every string the model was ever sent, joined. Cross-source read-out. */
  modelSawText(): string;
}

/**
 * An attempt-lease store that enforces the rule the real one does.
 *
 * `ports.ts` contract 3: "a lease that only unregisters on a clean exit holds a
 * run open forever after a crash". That sentence is only meaningful if acquiring
 * while another attempt is live is REFUSED, so this double refuses it. An
 * engine that failed to release on a dead run therefore cannot be recovered,
 * and the worker-exit test below observes exactly that rather than asserting it.
 */
class LeaseStore {
  #epoch = 0;
  #live: RunFence | null = null;
  readonly acquired: RunFence[] = [];
  readonly released: RunFence[] = [];

  async acquire(runId: RunId): Promise<RunFence> {
    if (this.#live !== null) {
      throw new Error(
        `run ${runId} already has a live attempt at epoch ${this.#live.runEpoch}; a lease that only unregisters on a clean exit holds the run open forever`,
      );
    }
    this.#epoch += 1;
    this.#live = { runId, runEpoch: this.#epoch, token: this.#epoch };
    this.acquired.push(this.#live);
    return this.#live;
  }

  async release(fence: RunFence): Promise<void> {
    this.released.push(fence);
    if (this.#live?.runEpoch === fence.runEpoch) this.#live = null;
  }

  async current(runId: RunId): Promise<{ readonly epoch: number; readonly fence: number } | null> {
    return this.#live === null ? null : { epoch: this.#live.runEpoch, fence: this.#live.token };
  }

  /** The highest epoch this store has EVER issued, live or not. */
  highestEpoch(): number {
    return this.#epoch;
  }
}

function harness(options: HarnessOptions): Harness {
  const log: string[] = [];
  const dispatched: ToolCallRequest[] = [];
  const events: RunEvent[] = [];
  const terminals: Harness['terminals'] = [];
  const ledger: string[] = [];
  const records: ToolResultRecord[] = [];
  const summaries: TurnOutputSummary[] = [];
  const sentMessages: ModelMessage[][] = [];
  const sweeps: string[] = [];
  const leases = options.leaseStore ?? new LeaseStore();
  /** Results produced by a dispatch, awaiting the drain that will yield them. */
  const landed = new Map<string, ToolDrainItem[]>();
  let drainEntries = 0;
  let toolRuns = 0;
  let turnIndex = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      const turn = turnIndex + 1;
      turnIndex += 1;
      log.push(`model.stream:${turn}`);
      // Snapshot what the model was handed BEFORE yielding, because the engine
      // keeps its own message array and reading it later would compare a value
      // against its own future mutation.
      sentMessages.push([...request.messages]);
      const scripted = options.turns[turnIndex - 1];
      if (scripted === undefined) {
        yield { type: 'turn_stopped', reason: 'end_turn' };
        return;
      }
      // The frames go out FIRST and the transport dies after them, so a scripted
      // death lands with the turn's tool calls already dispatched. Dying before
      // the first frame is a different scenario (a run that never spoke) and
      // would make the mid-flight assertions vacuous.
      for (const frame of scripted.frames) yield frame;
      if (scripted.diesWith !== undefined) throw scripted.diesWith;
    },
  };

  const tools: HarnessOptions['tools'] = options.tools ?? [];

  const toolPort: RunEnginePorts['tools'] = {
    dispatch(call: ToolCallRequest): void {
      log.push(`tools.dispatch:${call.name}`);
      dispatched.push(call);
      // Find the producer script for THIS call. A call with no script never
      // produces a result, which is how a DANGLING call is scripted.
      const script = tools.find((candidate) => candidate.callId === call.callId);
      if (script === undefined) return;
      toolRuns += 1;
      const batch = landed.get(call.callId) ?? [];
      // Stated exactly as the producer would, tri-state and all.
      batch.push({
        kind: 'tool_result',
        callId: call.callId,
        content: script.answer,
        ...(script.isError === undefined ? {} : { isError: script.isError }),
        durationMs: 7,
      });
      landed.set(call.callId, batch);
    },
    async *drain(): AsyncIterable<ToolDrainItem> {
      drainEntries += 1;
      log.push('tools.drain');
      // Serve the results whose producer script says THIS turn is theirs.
      const due: ToolDrainItem[] = [];
      for (const [callId, batch] of landed) {
        const script = tools.find((candidate) => candidate.callId === callId);
        const deliverOn = script?.deliverOnTurn ?? turnIndex;
        if (deliverOn !== turnIndex) continue;
        due.push(...batch);
        landed.set(callId, []);
      }
      // A gate models a tool that has NOT finished yet. The drain is open and
      // waiting, which is the state a cancellation has to be proven against --
      // a drain that yields instantly has nothing in flight to cancel.
      const gate = tools.find((candidate) => candidate.drainGate !== undefined)?.drainGate;
      if (gate !== undefined) await gate;
      for (const item of due) yield item;
    },
    discard(reason: string): void {
      log.push(`tools.discard:${reason}`);
      landed.clear();
    },
    describe(): readonly ToolDescriptor[] {
      return tools.map((script) => ({
        name: script.name,
        description: `scripted ${script.name}`,
        inputSchema: {},
      }));
    },
  };

  const sideEffects: ToolSideEffectLedger = {
    async begin(call: ToolCallRequest) {
      // By callId, not by name, so the interleaving log names the same
      // identity the ledger rows do. A three-call run against one tool name
      // produces three indistinguishable entries otherwise.
      log.push(`ledger.begin:${call.callId}`);
      ledger.push(`begin:${call.callId}`);
      return {
        attemptKey: `key:${call.callId}`,
        runId: RUN_ID,
        runEpoch: 1,
        fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
      };
    },
    async settle(input) {
      log.push(`ledger.settle:${input.attemptKey}:${input.state}`);
      ledger.push(`settle:${input.attemptKey}:${input.state}`);
      if (options.rejectWrite === 'settle') {
        throw new Error('the side-effect ledger refused the write');
      }
    },
    async reconcile(): Promise<void> {},
    async read() {
      return [];
    },
  };

  const ports: RunEnginePorts = {
    model,
    tools: toolPort,
    context: {
      async assemble(): Promise<AssembledTurn> {
        log.push('context.assemble');
        if (options.rejectWrite === 'assemble') {
          throw new Error('the transcript store refused to assemble this turn');
        }
        return {
          systemPrompt: 'you are a test',
          messages: [],
          tools: tools.map((script) => ({
            name: script.name,
            description: `scripted ${script.name}`,
            inputSchema: {},
          })),
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      async authorize(request): Promise<ApprovalVerdict> {
        log.push(`approval.authorize:${request.toolName}`);
        return options.denyApproval === true
          ? { allowed: false, reason: 'denied' }
          : { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(event: RunEvent): void {
        log.push(`events.publish:${event.type}`);
        events.push(event);
      },
      proposeTerminal(candidate): void {
        log.push('events.proposeTerminal');
        terminals.push({
          state: candidate.state as Harness['terminals'][number]['state'],
          reason: candidate.reason,
        });
      },
    } as RunEventStorePort,
    sideEffects,
    // Required since A3-1 (PR #236). A host with nothing queued SAYS so rather
    // than leaving the port out, which is a compile error in src/ -- but TEST
    // dirs are excluded from every tsconfig, so an omitted member here is never
    // caught by the compiler. It surfaces as a runtime
    // `Cannot read properties of undefined (reading 'sweep')` that the engine
    // reports as a `failed` run, which is indistinguishable from a real
    // scenario outcome. That is why this literal is explicit.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    turnOutput: {
      async recordToolResult(record: ToolResultRecord): Promise<void> {
        log.push('turnOutput.recordToolResult');
        records.push(record);
        if (options.rejectWrite === 'recordToolResult') {
          throw new Error('the transcript store refused this tool result');
        }
      },
      async recordAssistantMessage(): Promise<void> {
        log.push('turnOutput.recordAssistantMessage');
      },
      async finishTurn(summary: TurnOutputSummary): Promise<void> {
        log.push('turnOutput.finishTurn');
        summaries.push(summary);
        if (options.rejectWrite === 'finishTurn') {
          throw new Error('the transcript store refused the turn summary');
        }
      },
    },
    ...(options.lease === true
      ? {
          attempt: {
            acquire: (runId: RunId) => leases.acquire(runId),
            release: (fence: RunFence) => leases.release(fence),
            current: (runId: RunId) => leases.current(runId),
          },
        }
      : {}),
    ...(options.subtasks === true
      ? {
          subtasks: {
            register: () => ({
              terminate: () =>
                Promise.resolve({
                  subtaskId: 's1',
                  reason: 'completed' as const,
                  outcome: 'killed' as const,
                }),
            }),
            async terminateAll(reason: SubtaskTerminationReason, rule: { includeDetached: boolean }) {
              sweeps.push(`${reason}:${String(rule.includeDetached)}`);
              log.push(`subtasks.terminateAll:${reason}`);
              return [{ subtaskId: 's1', reason, outcome: 'killed' as const }];
            },
            list: () => ['s1'],
          },
        }
      : {}),
  };

  return {
    ports,
    log,
    dispatched,
    events,
    terminals,
    ledger,
    records,
    summaries,
    sentMessages,
    sweeps,
    leases,
    drainEntries: () => drainEntries,
    toolRuns: () => toolRuns,
    modelSawText: () =>
      sentMessages
        .flat()
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n'),
  };
}

function manifestFor(overrides: Record<string, unknown> = {}): never {
  return {
    version: 1,
    runId: RUN_ID,
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1_000 },
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
    ...overrides,
  } as never;
}

function inputFor(overrides: Record<string, unknown> = {}): never {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'do the thing' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
    ...overrides,
  } as never;
}

/** A clock the test moves by hand, so nothing here depends on wall time. */
function fakeClock(): () => number {
  let t = 1_000;
  return () => t;
}

async function run(
  engine: RunEngineImpl,
  h: Harness,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const controller = new AbortController();
  await engine
    .execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: options.signal ?? controller.signal,
      ports: h.ports,
    })
    .completed();
}

/** A turn that asks for `name` and then ends its provider turn. */
function asksFor(name: string, callId: string): ScriptedTurn {
  return {
    frames: [
      {
        type: 'tool_use',
        call: { callId, name, input: {}, sideEffect: 'read_only' },
      },
    ],
  };
}

/** A turn that says something and asks for nothing. */
function answers(): ScriptedTurn {
  return { frames: [{ type: 'text', text: 'all done' }] };
}

// ============================================================================
// 1. 澶氳疆 -- multi-turn
//
// MIS-IMPLEMENTATION PROVEN AGAINST: `deferred.length = 0` removed from
// `#run` (`run-engine.ts:544`). The fragments a turn drained are then never
// consumed, so every later turn re-sends every earlier turn's tool results.
// ============================================================================

describe('multi-turn: a tool result reaches the model exactly once, on the turn after its call', () => {
  it('three turns, three answers, each delivered once and then dropped', async () => {
    const h = harness({
      tools: [
        { callId: 'call-1', name: 'probe', answer: answerFor(1) },
        { callId: 'call-2', name: 'probe', answer: answerFor(2) },
        { callId: 'call-3', name: 'probe', answer: answerFor(3) },
      ],
      turns: [
        asksFor('probe', 'call-1'),
        asksFor('probe', 'call-2'),
        asksFor('probe', 'call-3'),
        answers(),
      ],
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // POSITIVE EVIDENCE, first. Without it every assertion below would also
    // hold against an engine that ran a single turn and stopped.
    expect(h.log.filter((entry) => entry.startsWith('model.stream'))).toEqual([
      'model.stream:1',
      'model.stream:2',
      'model.stream:3',
      'model.stream:4',
    ]);
    expect(h.dispatched.map((call) => call.callId)).toEqual(['call-1', 'call-2', 'call-3']);
    expect(h.toolRuns()).toBe(3);

    // THE CROSS-SOURCE ASSERTION. `answerFor(n)` was written by the scripted
    // producer above; what is counted here is read out of the requests the
    // model port was actually invoked with. The engine cannot guess these
    // strings, and a facade that delegated to a legacy generator would not
    // produce per-turn requests at all.
    //
    // Each answer appears EXACTLY ONCE across the whole run. Exactly once is
    // the claim in both directions: zero would mean the backfill is broken, and
    // twice would mean the fragment is accumulating -- which is the mutation.
    for (const turn of [1, 2, 3]) {
      const occurrences = h.sentMessages
        .flat()
        .filter((message) => JSON.stringify(message.content).includes(answerFor(turn))).length;
      expect(occurrences, `answer for turn ${turn}`).toBe(1);
    }

    // Positional, so "once" is not satisfied by all three landing on turn 2.
    // The request that carries a result is the one AFTER the dispatch that
    // produced it: the model cannot answer a question it has not been asked.
    const turnOfFirstAnswer = h.sentMessages.findIndex((messages) =>
      messages.some((message) => JSON.stringify(message.content).includes(answerFor(1))),
    );
    expect(turnOfFirstAnswer).toBe(1);

    // The prompt rides along once, on the first turn only.
    const prompts = h.sentMessages
      .flat()
      .filter((message) => message.id === 'p1').length;
    expect(prompts).toBe(1);
  });

  it('settles every dispatched call against the key the LEDGER minted', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER }],
      turns: [asksFor('probe', 'call-1'), answers()],
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // Two independent sources per row: the callId the ENGINE dispatched, and
    // the attemptKey the LEDGER minted at `begin`. A settle written against the
    // callId would be a settle against a row that does not exist, and it would
    // read as `settle:call-1:succeeded` rather than `settle:key:call-1:succeeded`.
    expect(h.dispatched).toHaveLength(1);
    expect(h.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
  });
});

// ============================================================================
// 2. 宸ュ叿鎶ラ敊 -- tool error
//
// MIS-IMPLEMENTATION PROVEN AGAINST: `item.isError === true ? 'failed' :
// 'succeeded'` in `#drainOutcomes` (`run-engine.ts:1340`) replaced with a
// hard-coded `'succeeded'`. A failed tool is then recorded as a landed effect,
// which is the state that tells a crash-recovery "this happened, retry is
// safe" when it is not.
// ============================================================================

describe('tool error: a stated failure reaches the model AND fails the ledger row', () => {
  it('surfaces the failure text to the model and settles the row as failed', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_FAILURE, isError: true }],
      turns: [asksFor('probe', 'call-1'), answers()],
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // POSITIVE EVIDENCE: the tool ran, and the loop went round again.
    expect(h.toolRuns()).toBe(1);
    expect(h.log.filter((entry) => entry.startsWith('model.stream'))).toHaveLength(2);

    // The failure text the PRODUCER returned, read out of the REQUEST the model
    // port received. A swallowed error loses it here and nowhere else.
    expect(h.modelSawText()).toContain(TOOL_FAILURE);

    // The LEDGER's own answer, which is a different question from the one above
    // and resolves the tri-state differently on purpose: a STATED failure fails
    // the row.
    expect(h.ledger).toEqual(['begin:call-1', 'settle:key:call-1:failed']);
    // And it is not merely absent from the log: the row is positively `failed`,
    // which is what the mutation removes.
    expect(h.ledger.some((row) => row.endsWith(':failed'))).toBe(true);
    expect(h.ledger.some((row) => row.endsWith(':succeeded'))).toBe(false);

    // The event carries the producer's own classification, not the engine's
    // guess. `indeterminate` would be a different claim again.
    const completed = h.events.find((event) => event.type === 'tool.call_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(completed.outcome).toEqual({
      outcome: 'tool_error',
      error: { code: 'tool_failed', message: TOOL_FAILURE },
    });

    // The host was handed the SAME item, by identity: the record's outcome is
    // the drain item, not a re-derivation of it.
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.outcome.isError).toBe(true);
    expect(h.records[0]?.toolName).toBe('probe');
  });

  it('keeps going after a tool error rather than ending the run', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_FAILURE, isError: true }],
      turns: [asksFor('probe', 'call-1'), answers()],
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // A tool error is the MODEL's problem to answer, not the run's ending. The
    // terminal is the model's own `completed`, not a failure the engine invented.
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state).toEqual({ status: 'completed' });
  });
});

// ============================================================================
// 3. 鍙栨秷 -- cancellation, with something genuinely IN FLIGHT
//
// MIS-IMPLEMENTATION PROVEN AGAINST: the `isAborted(signal)` guard at the top
// of the drain loop (`run-engine.ts:1314`) removed. The abandoned run then
// settles, publishes and hands the host a result for a call the user just
// stopped -- a side effect after the run was told to stop.
// ============================================================================

describe('cancellation: an in-flight tool result is abandoned, not delivered', () => {
  it('stops with a live drain open and never settles the abandoned result', async () => {
    const controller = new AbortController();
    // The gate never opens on its own. The drain is therefore OPEN and WAITING
    // when the abort lands, which is the whole point: a drain that yields
    // instantly has nothing in flight, and "cancelled" would be a claim about
    // a run that had already finished.
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER, drainGate: gate }],
      turns: [asksFor('probe', 'call-1'), answers()],
    });

    // Abort once the drain is provably open and waiting, so the cancellation
    // lands mid-flight rather than before the run began.
    const originalDrain = h.ports.tools.drain;
    let drainWasOpen = false;
    h.ports.tools.drain = ((signal: AbortSignal) => {
      const iterable = originalDrain.call(h.ports.tools, signal);
      return (async function* () {
        drainWasOpen = true;
        yield* iterable;
      })();
    }) as typeof h.ports.tools.drain;

    const running = run(new RunEngineImpl({ now: fakeClock() }), h, { signal: controller.signal });
    // Let the engine reach the drain: assemble, stream, dispatch, then the
    // drain parks on the gate.
    for (let tick = 0; tick < 20 && !drainWasOpen; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(drainWasOpen, 'the drain should be open before the abort').toBe(true);
    controller.abort(new Error('the user pressed stop'));
    openGate();
    await running;

    // POSITIVE EVIDENCE that something WAS in flight: a call really was
    // dispatched and the producer really did run it.
    expect(h.dispatched.map((call) => call.callId)).toEqual(['call-1']);
    expect(h.toolRuns()).toBe(1);
    expect(h.drainEntries()).toBe(1);

    // The run reports a cancellation, from two independent sources: the
    // candidate the engine proposed, and the reason it recorded.
    expect(h.terminals[0]?.state).toEqual({ status: 'cancelled' });

    // THE CLAIM. A cancelled run must not report a result it abandoned. Three
    // separate ports could each have leaked it, so all three are checked:
    // the ledger (did it close the call out?), the event stream (did it announce
    // a completion?), and the host's transcript (did it get the record?).
    expect(h.ledger.filter((row) => row.startsWith('settle:'))).toEqual([]);
    expect(h.events.filter((event) => event.type === 'tool.call_completed')).toEqual([]);
    expect(h.records).toEqual([]);

    // And the queued work was dropped rather than left to fire on a later turn.
    expect(h.log).toContain('tools.discard:abandoned');
  });

  it('never opens a second turn after a cancellation', async () => {
    const controller = new AbortController();
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER, drainGate: gate }],
      turns: [asksFor('probe', 'call-1'), answers(), answers()],
    });

    const originalDrain = h.ports.tools.drain;
    let drainWasOpen = false;
    h.ports.tools.drain = ((signal: AbortSignal) => {
      const iterable = originalDrain.call(h.ports.tools, signal);
      return (async function* () {
        drainWasOpen = true;
        yield* iterable;
      })();
    }) as typeof h.ports.tools.drain;

    const running = run(new RunEngineImpl({ now: fakeClock() }), h, { signal: controller.signal });
    for (let tick = 0; tick < 20 && !drainWasOpen; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort(new Error('stop'));
    openGate();
    await running;

    // Exactly one model call. The engine is not allowed to finish the turn it
    // was in and then ask the model what to do about it.
    expect(h.log.filter((entry) => entry.startsWith('model.stream'))).toEqual(['model.stream:1']);
    // And nothing reached the model on any turn.
    expect(h.modelSawText()).not.toContain(TOOL_ANSWER);
  });
});

// ============================================================================
// 4. 瀛樺偍鎷掔粷 -- storage rejection
//
// MIS-IMPLEMENTATION PROVEN AGAINST: the `catch` in `#run` (`run-engine.ts:684`)
// narrowed to swallow host-write rejections, i.e. `exit` left at its `completed`
// initial value. A run whose transcript store refused the turn then reports
// success, and the transcript has a hole in it.
// ============================================================================

describe('storage rejection: a refused host write is a failed run, not a completed one', () => {
  it('fails the run when the transcript store refuses the tool result', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER }],
      turns: [asksFor('probe', 'call-1'), answers()],
      rejectWrite: 'recordToolResult',
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // POSITIVE EVIDENCE: the write was actually attempted. A test that only
    // checked the terminal would pass against an engine that never got as far
    // as the host at all.
    expect(h.log).toContain('turnOutput.recordToolResult');
    expect(h.records).toHaveLength(1);

    // THE CLAIM. The refusal is in the terminal, and the terminal is a failure.
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state.status).toBe('failed');
    expect(h.terminals[0]?.state.error?.message).toContain('refused this tool result');

    // It did not quietly carry on and finish: a second turn would mean the
    // engine treated an unwritten result as if it were written.
    expect(h.log.filter((entry) => entry.startsWith('model.stream'))).toEqual(['model.stream:1']);
  });

  it('fails the run when the SIDE-EFFECT LEDGER refuses the settle', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER }],
      turns: [asksFor('probe', 'call-1'), answers()],
      rejectWrite: 'settle',
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    expect(h.log).toContain('ledger.settle:key:call-1:succeeded');
    expect(h.terminals[0]?.state.status).toBe('failed');
    // The order matters and is the reason this is a scenario at all: the
    // ledger row is written BEFORE the result is announced, so a ledger that
    // refuses means the run must not have announced the effect. The engine
    // must not publish a "this worked" ahead of the row that proves it.
    expect(h.events.filter((event) => event.type === 'tool.call_completed')).toEqual([]);
  });

  it('fails the run when the transcript store cannot even assemble a turn', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER }],
      turns: [asksFor('probe', 'call-1'), answers()],
      rejectWrite: 'assemble',
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    expect(h.log.filter((entry) => entry === 'context.assemble')).toHaveLength(1);
    expect(h.terminals[0]?.state.status).toBe('failed');
    // Nothing was dispatched, so nothing may be reported as dispatched.
    expect(h.dispatched).toEqual([]);
    expect(h.ledger).toEqual([]);
  });
});

// ============================================================================
// 5. worker 閫€鍑?-- worker exit, and the RECOVERY it has to leave behind
//
// MIS-IMPLEMENTATION PROVEN AGAINST: `#releaseFence` moved out of the `finally`
// in `#run` (`run-engine.ts:699`) so a lease is only released on a clean exit.
// The corpse's lease is then still live, the next attempt's `acquire` is
// refused, and the run is unrecoverable -- which is precisely what contract 3
// says a lease exists to prevent.
// ============================================================================

describe('worker exit: a dead run releases its lease so the next attempt can start', () => {
  it('releases the attempt on a mid-turn transport death, and a new epoch follows', async () => {
    const h = harness({
      tools: [{ callId: 'call-1', name: 'probe', answer: TOOL_ANSWER }],
      // The transport dies AFTER the tool was dispatched, so the run is killed
      // with a call in flight rather than before it began.
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'call-1', name: 'probe', input: {}, sideEffect: 'read_only' },
            },
          ],
          diesWith: new Error('the worker socket closed'),
        },
      ],
      lease: true,
      subtasks: true,
    });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    // POSITIVE EVIDENCE that the death was mid-flight, not a clean empty run.
    expect(h.dispatched).toHaveLength(1);
    expect(h.log).toContain('ledger.begin:call-1');
    expect(h.leases.acquired).toHaveLength(1);

    // The transport's own message reaches the terminal, so the failure is
    // attributable rather than a bare "failed".
    expect(h.terminals[0]?.state.status).toBe('failed');
    expect(h.terminals[0]?.state.error?.message).toContain('the worker socket closed');

    // THE CLAIM, part 1: the corpse's lease is gone. Read from the STORE's own
    // view, not from a flag the engine set.
    expect(h.leases.released).toHaveLength(1);
    expect(await h.leases.current(RUN_ID)).toBeNull();

    // A failure sweep INCLUDES detached subtasks: a run that cannot record its
    // own failure must not leave orphans outliving it.
    expect(h.sweeps).toEqual(['parent_failure:true']);

    // THE CLAIM, part 2: recovery. A second attempt on the same runId, against
    // the SAME durable store, acquires a STRICTLY NEWER epoch -- which is what
    // makes a late write from the corpse distinguishable from a live one. Two
    // independent sources: the store's own highest epoch ever issued, and the
    // fence the new attempt holds. And the second attempt runs to a normal
    // completion, which is only reachable because the corpse's lease was
    // released: a store that still held it would have refused this `acquire`.
    const store = h.leases;
    const corpseEpoch = store.highestEpoch();
    const second = harness({ turns: [answers()], lease: true, leaseStore: store });
    await run(new RunEngineImpl({ now: fakeClock() }), second);
    // The store has now issued two fences, one per attempt.
    expect(store.acquired).toHaveLength(2);
    const newFence = store.acquired[1];
    expect(newFence).toBeDefined();
    expect(newFence?.runEpoch).toBeGreaterThan(corpseEpoch);
    expect(second.terminals[0]?.state).toEqual({ status: 'completed' });
    // Two attempts, two epochs, and the corpse's fence was the one released.
    expect(store.acquired.map((fence) => fence.runEpoch)).toEqual([1, 2]);
    expect(store.released.map((fence) => fence.runEpoch)).toEqual([1, 2]);
  });

  it('releases the attempt on a clean exit too', async () => {
    // The complement, and the one a mutation that simply deletes the release
    // would still pass. A lease held by a SUCCESSFUL run is the same outage.
    const h = harness({ turns: [answers()], lease: true });

    await run(new RunEngineImpl({ now: fakeClock() }), h);

    expect(h.leases.acquired).toHaveLength(1);
    expect(h.leases.released).toHaveLength(1);
    expect(await h.leases.current(RUN_ID)).toBeNull();
  });
});

// ============================================================================
// 6. 鎱㈡秷璐硅€?-- slow consumer
//
// NOT asserted in this file, and deliberately not asserted as a stub: that
// scenario needs a real `BoundedEventQueue` and a real `RunEventEmitter`
// rather than recorders, so it lives in `engine-scenario-slow-consumer.test.ts`
// next to the defect this slice found on that path. A placeholder `it` here
// would be the shallow test this suite exists to avoid.
// ============================================================================
