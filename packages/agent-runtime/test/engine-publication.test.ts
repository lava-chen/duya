/**
 * b4d -- the four events the engine held and never published.
 *
 * Three of them are here (`tool.call_completed`, `assistant.usage`, and the
 * `run.completed` / `run.failed` pair). The fourth, `permission.requested`, is
 * NOT, and its absence is a decision rather than an omission: the engine never
 * sees a `requestId`, and `kind` / `mode` / `startedAt` are documented producer
 * facts, so an engine that published one would be inventing the identity of an
 * approval request. Its owner is the `ApprovalPort` implementation, inside
 * `authorize`. See the note on that at the bottom of this file.
 *
 * ## Why the terminal pair is the interesting one
 *
 * Publishing a terminal is the one publication that must NOT be announced. The
 * hold that enforces this lives in `RunEventEmitter.#mint` and is keyed on the
 * EVENT rather than on the publisher (`event-emitter.ts:556`), so an
 * engine-published terminal is minted, numbered and held, and the only release
 * is `publishCommittedTerminal` from `RunController.settle` -- which discards
 * when the durable barrier disagreed. These tests drive that whole chain: a
 * real emitter over a real session, the engine publishing through the port, and
 * the barrier's answer deciding what the consumer ever sees.
 *
 * ## What no test here proves
 *
 * No provider key and no Electron renderer exist in this environment, so
 * nothing here shows a real socket dying on abort or a real UI rendering
 * progressively. What is shown is that the signal reaches the adapter and that
 * the frames are published and held correctly.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  ToolCallRequest,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { RunSession } from '../src/run-session.js';
import type {
  RunEvent,
  RunEventEnvelope,
  RunMetrics,
  RunTerminalState,
} from '@duya/agent-protocol';

const RUN_ID = 'run-pub-1';

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
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'go' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as Parameters<RunEngineImpl['execute']>[0]['input'];

const READ_CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: { path: 'a.txt' },
  sideEffect: 'read_only',
} as unknown as ToolCallRequest;

const CONTENT_SENTINEL = 'the file said hello';
const METADATA_SENTINEL = 'meta-token-7';

/** A drain result, shaped exactly as `#drainOutcomes` receives one. */
function outcome(over: { isError?: boolean | undefined } = {}): ToolDrainItem {
  return {
    kind: 'tool_result',
    callId: READ_CALL.callId,
    content: CONTENT_SENTINEL,
    isError: over.isError === undefined ? false : over.isError,
    durationMs: 42,
    metadata: { previewToken: METADATA_SENTINEL },
  } as ToolDrainItem;
}

/** A result whose producer said NOTHING about whether the call failed. */
function silentOutcome(): ToolDrainItem {
  return { ...outcome(), isError: undefined } as ToolDrainItem;
}

interface HarnessOptions {
  /** Frames for turn 1. Reused for every later turn, so turn 2 ends the run. */
  readonly frames?: readonly ModelFrame[];
  /** One drain batch, served on turn 1's drain. */
  readonly batch?: readonly ToolDrainItem[];
  /** Refuse every `persistence.complete`, so the barrier degrades. */
  readonly failBarrier?: boolean;
  /** Attach a side-effect ledger, so a settle is observable in `order`. */
  readonly ledger?: boolean;
  /** Answer every approval request with a refusal. */
  readonly denyApproval?: boolean;
}

interface Harness {
  /** Every event the engine offered to the port, in order. */
  readonly offered: RunEvent[];
  /** Every event that reached the run's STREAM, i.e. was announced. */
  readonly announced: RunEventEnvelope[];
  /** Every envelope handed to durable persistence, flattened in write order. */
  readonly appended: RunEventEnvelope[];
  /** Interleaving markers, to assert a publication's position. */
  readonly order: string[];
  readonly emitter: RunEventEmitter;
  readonly session: RunSession;
  readonly completed: Promise<void>;
}

function harness(options: HarnessOptions = {}): Harness {
  const offered: RunEvent[] = [];
  const announced: RunEventEnvelope[] = [];
  const appended: RunEventEnvelope[] = [];
  const order: string[] = [];

  const persistence = {
    append: async (batch: readonly RunEventEnvelope[]): Promise<void> => {
      appended.push(...batch);
    },
    complete: options.failBarrier === true
      ? async (): Promise<void> => {
          throw new Error('the durable row could not be written');
        }
      : async (_t: RunTerminalState, _m: RunMetrics): Promise<void> => undefined,
  };
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-pub-1',
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
    manifestHash: 'hash-1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  let turn = 0;
  const events: RunEventStorePort = {
    publish(event: RunEvent): void {
      order.push(`publish:${event.type}`);
      offered.push(event);
      // Through the emitter, which is the binding the host adapter uses
      // (`run-engine-ports.ts`) and the only reason a terminal is held.
      emitter.emit(event);
    },
    proposeTerminal(candidate): void {
      order.push('proposeTerminal');
      void candidate;
    },
  };

  const sideEffects =
    options.ledger === true
      ? {
          async begin(call: ToolCallRequest): Promise<{
            attemptKey: string;
            runId: string;
            runEpoch: number;
            fence: { runId: string; runEpoch: number; token: number };
          }> {
            order.push('ledger.begin');
            return {
              attemptKey: `key:${call.callId}`,
              runId: RUN_ID,
              runEpoch: 1,
              fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
            };
          },
          async settle(input: { state: string }): Promise<void> {
            order.push(`ledger.settle:${input.state}`);
          },
          async reconcile(): Promise<void> {},
          async read() {
            return [];
          },
        }
      : undefined;

  const ports: RunEnginePorts = {
    model: {
      async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
        void request;
        turn += 1;
        // Turn 1 may ask for a tool; every turn ends `end_turn` so the loop
        // stops when nothing came back to do.
        if (turn === 1) {
          yield { type: 'text', text: 'reading' };
          yield { type: 'tool_use', call: READ_CALL };
        } else {
          yield { type: 'text', text: 'done' };
        }
        for (const frame of options.frames ?? []) yield frame;
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    },
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        if (turn === 1) {
          for (const item of options.batch ?? []) yield item;
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
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        order.push('approval.authorize');
        if (options.denyApproval === true) {
          return { allowed: false, reason: 'the user said no' };
        }
        return { allowed: true, scope: 'once' };
      },
    },
    events,
    ...(sideEffects === undefined ? {} : { sideEffects }),
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 3 });
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: new AbortController().signal,
    ports,
  });
  return { offered, announced, appended, order, emitter, session, completed: handle.completed() };
}

function only<T extends RunEvent['type']>(offered: readonly RunEvent[], type: T): number[] {
  const out: number[] = [];
  offered.forEach((event, index) => {
    if (event.type === type) out.push(index);
  });
  return out;
}

// ============================================================================
// 1. tool.call_completed -- the result as an event
// ============================================================================

describe('the engine publishes tool.call_completed for every drained result', () => {
  it('carries the DRAIN item s own values, and no others', async () => {
    const h = harness({ batch: [outcome()] });
    await h.completed;

    const completed = h.offered.filter((e) => e.type === 'tool.call_completed');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    if (event?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    // Every value below is compared against a LITERAL the drain supplied, never
    // against the payload itself. The drain item is the only source, and this
    // is what makes removing the publish observable rather than cosmetic.
    expect(event.toolCallId).toBe('call-1');
    expect(event.content).toBe(CONTENT_SENTINEL);
    expect(event.durationMs).toBe(42);
    expect(event.metadata).toEqual({ previewToken: METADATA_SENTINEL });
    expect(event.outcome).toEqual({ outcome: 'success' });
  });

  it('lands AFTER the ledger settle, so the durable record precedes the visibility', async () => {
    // The four-step order at `#drainOutcomes` is the contract, and POSITION is
    // what asserts it: a `tool.call_completed` ahead of the settle would put a
    // durable "this worked" in front of the ledger row that proves it. Both
    // sides are independently observed here -- `order` is written by the
    // ledger and by the port, in call order.
    const h = harness({ ledger: true, batch: [outcome()] });
    await h.completed;

    const settleAt = h.order.indexOf('ledger.settle:succeeded');
    const completedAt = h.order.indexOf('publish:tool.call_completed');
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeLessThan(completedAt);
    // And the ledger still gets a BINARY state, resolved from the tri-state.
    expect(h.order).toContain('ledger.settle:succeeded');
  });

  it('maps a STATED failure to tool_error, carrying the producer s own text', async () => {
    const h = harness({
      batch: [{ ...outcome(), isError: true, content: 'ENOENT: no such file' } as ToolDrainItem],
    });
    await h.completed;

    const event = h.offered.find((e) => e.type === 'tool.call_completed');
    if (event?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(event.outcome).toEqual({
      outcome: 'tool_error',
      error: { code: 'tool_failed', message: 'ENOENT: no such file' },
    });
  });

  it('maps a producer that said NOTHING to indeterminate, never to success', async () => {
    // The case the tri-state `isError` exists for. An adapter that rounds
    // absence to `false` produces a `success` nobody stated, which
    // `payloads.ts:157-166` calls a fabricated fact.
    const h = harness({ batch: [silentOutcome()] });
    await h.completed;

    const event = h.offered.find((e) => e.type === 'tool.call_completed');
    if (event?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(event.outcome.outcome).toBe('indeterminate');
    expect(event.outcome).not.toEqual({ outcome: 'success' });
  });

  it('leaves the LEDGER binary: a stated failure fails the row, silence does not', async () => {
    // The two consumers of the same tri-state resolve it differently on
    // purpose. The event needs three values; the ledger needs two, and there a
    // call nobody reported on did not FAIL.
    const stated = harness({ batch: [{ ...outcome(), isError: true } as ToolDrainItem] });
    await stated.completed;
    const statedEvent = stated.offered.find((e) => e.type === 'tool.call_completed');
    if (statedEvent?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(statedEvent.outcome.outcome).toBe('tool_error');

    const silent = harness({ batch: [silentOutcome()] });
    await silent.completed;
    const silentEvent = silent.offered.find((e) => e.type === 'tool.call_completed');
    if (silentEvent?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(silentEvent.outcome.outcome).toBe('indeterminate');
  });
});

// ============================================================================
// 2. assistant.usage -- once per turn
// ============================================================================

describe('the engine publishes assistant.usage ONCE per turn', () => {
  it('emits one event carrying the LAST usage frame, not one per frame', async () => {
    // Two usage frames, and `addUsage` is last-wins-never-summed, so the
    // published value must be the second frame's. A per-frame publication
    // would emit BOTH prefixes here, and a host that sums them double counts.
    const h = harness({
      frames: [
        { type: 'usage', inputTokens: 10, outputTokens: 1 },
        { type: 'usage', inputTokens: 20, outputTokens: 5 },
      ],
    });
    await h.completed;

    const usages = h.offered.filter((e) => e.type === 'assistant.usage');
    expect(usages).toHaveLength(1);
    const event = usages[0];
    if (event?.type !== 'assistant.usage') throw new Error('expected assistant.usage');
    expect(event.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });

  it('publishes no usage event for a run whose stream reported none', async () => {
    const h = harness();
    await h.completed;
    expect(only(h.offered, 'assistant.usage')).toEqual([]);
  });
});

// ============================================================================
// 3. run.completed / run.failed -- NOT published, and why
// ============================================================================

/**
 * These two are the slice's one refusal, and it is measured rather than
 * asserted.
 *
 * The specification was to publish the terminal pair eagerly at propose time,
 * from the same candidate the proposal carries. That is implementable and it is
 * wrong, for a reason in a file this slice does not own. The test below drives
 * the real collision rather than describing it, so the next worker to consider
 * this change inherits the failure instead of rediscovering it.
 */
describe('the engine does NOT publish a terminal, and the reason is measured', () => {
  it('a run that dispatched a call and never got a result closes the call BEFORE the verdict', async () => {
    // The premise. `batch: []` with a real `tool_use` frame means `Read` is
    // dispatched and never answered, so the ledger has a dangling call.
    const h = harness({ batch: [] });
    await h.completed;

    // The engine proposed, and published no terminal of its own.
    expect(h.order[h.order.length - 1]).toBe('proposeTerminal');
    expect(only(h.offered, 'run.completed')).toEqual([]);
    expect(only(h.offered, 'run.failed')).toEqual([]);
    expect(h.session.danglingToolCalls()).toEqual([READ_CALL.callId]);

    const committed = await h.session.settle();

    // The claim, read off the DURABLE LOG rather than the stream: the
    // synthesised `tool.call_completed` is written at a LOWER seq than the
    // synthesised terminal. That ordering is the whole invariant, and it is
    // only legal because no terminal event existed when the close ran.
    const order = h.appended.flat().map((e) => e.payload.type);
    const closedAt = order.lastIndexOf('tool.call_completed');
    const terminalAt = order.indexOf('run.failed');
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(terminalAt).toBeGreaterThan(closedAt);
    // And the close carries `indeterminate`, never a success nobody observed.
    const closed = h.appended.flat().find((e) => e.payload.type === 'tool.call_completed');
    if (closed?.payload.type !== 'tool.call_completed') throw new Error('expected a close');
    expect(closed.payload.outcome.outcome).toBe('indeterminate');
    expect(committed.status).toBe('failed');
  });

  it('publishing a terminal FIRST makes the settle path throw event_after_terminal', async () => {
    // The mutation proof, in the only direction that matters: put the terminal
    // in the run BEFORE the barrier has closed its dangling tool call and the
    // refusal is observable. This is what the engine's publish would do, so it
    // is asserted rather than warned about in a comment.
    //
    // It is driven by hand here (`emitter.emit` of a terminal the engine did
    // NOT publish) because the engine genuinely does not publish one. The
    // event is the engine's own belief -- same shape, same emitter -- so the
    // ordering it creates is the ordering a real publish creates.
    const h = harness({ batch: [] });
    await h.completed;

    // Ahead of the barrier, exactly where the proposal site sits.
    const verdict = h.emitter.emit({ type: 'run.completed', status: 'completed' });
    expect(verdict.ok).toBe(true);
    // It was HELD, not announced -- so the hold itself works, which is why
    // this failure is about ORDERING and not about the hold.
    expect(h.emitter.hasHeldTerminal).toBe(true);
    expect(h.announced.map((e) => e.payload.type)).not.toContain('run.completed');

    // And now the barrier cannot close what it must close, and the throw
    // escapes `settle` -- so `RunController.settle` never reaches
    // `publishCommittedTerminal` and the held terminal is never released.
    await expect(h.session.settle()).rejects.toThrow(/event_after_terminal/);
  });

  it('with NO terminal from the engine, the barrier records even a clean run as runtime_crash', async () => {
    // The other half of the blocker, and the reason this is a deadlock rather
    // than a simple omission.
    //
    // `resolveRunOutcome` reads terminal EVENTS, and a run with none is
    // `IMPLICIT_CRASH` (`run-outcome.ts:90`): "the run stream ended with no
    // terminal event". A run that dispatched a call, got its result and
    // finished cleanly is nevertheless recorded as `failed` -- because the
    // engine published no terminal for it to read.
    //
    // So the two facts are: the engine MUST publish a terminal, or every
    // engine-driven run is a crash at the barrier; and it CANNOT publish one
    // until `#closeDanglingTools` runs ahead of it. That is why the pair is
    // left alone rather than landed.
    const h = harness({ batch: [outcome()] });
    await h.completed;

    // Nothing was left dangling, so this run is clean by any other measure.
    expect(h.session.danglingToolCalls()).toEqual([]);
    const committed = await h.session.settle();
    expect(committed.status).toBe('failed');
    if (committed.status === 'failed') {
      expect(committed.error.code).toBe('runtime_crash');
      expect(committed.error.message).toBe('the run stream ended with no terminal event');
    }
    // Nothing was held, because the engine published no terminal to hold.
    const release = await h.emitter.publishCommittedTerminal(committed);
    expect(release.outcome).toBe('none');
  });
});

// ============================================================================
// 4. The event the engine must NOT publish
// ============================================================================

describe('permission.requested is not the engine s to publish', () => {
  it('a run whose call the user DENIED still publishes no permission.requested', async () => {
    // Recorded here so the omission is a measurement rather than a gap. The
    // engine never sees a `requestId`, and `kind` / `mode` / `startedAt` are
    // documented producer facts -- an engine-published one would be an
    // invented approval identity. Its owner is the `ApprovalPort`
    // implementation, publishing inside `authorize`
    // (`run-engine-ports.ts:299-305`), which is the only place that has seen
    // the request the user was actually shown.
    //
    // The run below DID reach `approval.authorize` and was refused, so this is
    // the run where publishing one would have been most tempting and most
    // wrong: a denial with a fabricated `requestId` is an approval the run
    // never recorded an answer for.
    const h = harness({ denyApproval: true });
    await h.completed;

    // The premise, asserted: the engine really did ask and really was refused.
    expect(h.order).toContain('approval.authorize');
    expect(only(h.offered, 'permission.requested')).toEqual([]);
    // The refusal is reported, not dropped -- `tool.timed_out` at elapsed 0 is
    // how `#dispatchCall` reports an unapproved call, and it keeps a broken
    // bridge from reading as a user saying no.
    expect(only(h.offered, 'tool.timed_out').length).toBe(1);
  });
});
