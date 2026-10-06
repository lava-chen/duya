/**
 * Plan 610 slice A4, scenario 6 of 6: 鎱㈡秷璐硅€?-- a consumer that stopped reading.
 *
 * ## Why this scenario is in its own file
 *
 * The other five are decided by what the engine DOES to its ports, so recorder
 * ports are enough. This one is decided by what happens DOWNSTREAM of the
 * engine's `events.publish`, so it needs the real `RunEventEmitter`, a real
 * `RunSession`, and a real `BoundedEventQueue` over a reader that is not
 * reading. A recorder cannot decide it, and asserting on a recorder's own
 * opinion of itself is the "green that means nothing" this suite exists to
 * avoid.
 *
 * ## What the engine can and cannot do about a slow consumer
 *
 * The engine's publication surface is `RunEventStorePort.publish(event): void`
 * (`packages/agent-runtime/src/engine/ports.ts:929`) and it is `void` in the
 * engine's own spine: every call site in `run-engine.ts` is
 * `ports.events.publish(...)` with no `await`. The arm that can apply
 * backpressure is `RunEventEmitter.publish` (`event-emitter.ts:344`), which
 * awaits `stream.whenWritable()` BEFORE minting -- and it is async.
 *
 * So the engine structurally cannot pause for a slow consumer: its port cannot
 * express an await, and the host adapter that does exist binds the SYNCHRONOUS
 * `emit` anyway (`run-engine-ports.ts:314`, `void sources.emitter.emit(event)`).
 * That is a property of the contract, not of this implementation, and it is
 * reported rather than asserted green: a test pinning "the engine does not
 * pause" would lock a defect in as intended behaviour, which is the mirror
 * image of the shallow test this slice is trying to avoid.
 *
 * ## The property that IS the engine's, and IS decided here
 *
 * Given a queue that has gone over its bound, the engine's own contribution is
 * that every DURABLE frame it published is still there, in order, and that the
 * run still reaches a terminal candidate rather than dying. Both are measurable
 * against the queue's own state and the engine's own proposals.
 *
 * ## A DEFECT THIS SLICE FOUND ON THIS PATH, since FIXED
 *
 * `RunEngineImpl` derived its run-scoped message id as
 * `` `${runId}:message` ``. The queue's merge path builds a coalescing key
 * with `coalesceKeyId` (`coalesce.ts:171`), which REFUSES any component
 * containing the key separator `:` (`coalesce.ts:181-187`) rather than
 * produce a key that decodes as another. `BoundedEventQueue.mergeIntoQueued`
 * calls it (`backpressure.ts:425`).
 *
 * Measured consequence, on this tree: a run that streams text deltas into a
 * real `BoundedEventQueue` DIED `failed`. The throw escaped
 * `ports.events.publish`, unwound `#streamModel`, and was caught by `#run`.
 * It fires on the run's FIRST `text_delta`, with the queue at 435 bytes and
 * `paused: false` - it does not need the queue to be over its bound, so it is
 * a cutover blocker rather than a slow-consumer edge case.
 *
 * Fixed in `run-engine.ts` by minting the id as `` `m-${runId}` ``, the shape
 * the two sibling hosts already use (`run-orchestrator.ts:924`,
 * `headless-run-host.ts:474`). The `coalesceKeyId` refusal is deliberately
 * NOT relaxed: it is what keeps a `messageId` holding the separator from
 * colliding with a different id and block index.
 *
 * This file stays scoped to the DURABLE path, and the delta half now lives
 * beside it in `engine-scenario-slow-consumer-delta.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { RunSession } from '../src/run-session.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
import type { RunEvent, RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-a4-slow' as RunId;

/** Big enough that a handful of durable frames fills it, so "over the bound" is about the COUNT. */
const MAX_BYTES = 900;
/** Turns the engine is driven through against a consumer that never reads. */
const DURABLE_TURNS = 5;
/** Tool calls per turn. Each one contributes two DURABLE frames and no delta. */
const CALLS_PER_TURN = 2;

/**
 * The durable event types this scenario measures.
 *
 * Read off the two families a tool call produces. Text is deliberately NOT
 * among them, because this file measures what a stopped reader costs the
 * DURABLE transcript specifically: a text frame also produces an EPHEMERAL
 * delta, and asserting on the durable families keeps that question separate.
 * The delta half of the same scenario is
 * `engine-scenario-slow-consumer-delta.test.ts`.
 */
const DURABLE_TYPES = new Set(['turn.started', 'tool.call_started', 'tool.call_completed']);

interface SlowRun {
  readonly queue: BoundedEventQueue;
  /** Every event the engine offered the port, in order. */
  readonly offered: RunEvent[];
  /** Terminal candidates the engine proposed. */
  readonly terminals: { state: { status: string }; reason: string }[];
  /** Durable event types the engine offered, in order. LAZY on purpose. */
  offeredDurable(): string[];
  readonly completed: Promise<void>;
}

/**
 * Drive a real engine at a real queue whose reader never reads.
 *
 * The queue is a real `BoundedEventQueue` and the publisher binds its real
 * `whenWritable`, so the queue's `paused` and its occupancy are the queue's own
 * facts rather than this file's opinion of them. Nothing is read until the run
 * has finished, which is the slow consumer.
 */
function startHeldConsumerRun(): SlowRun {
  const queue = new BoundedEventQueue({ runId: RUN_ID, maxBytes: MAX_BYTES });
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-a4-slow',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    // Flushed in one batch at the end, so persistence never interleaves with
    // the measurements below and the queue is the only thing under pressure.
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 10_000,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: {
      push: (envelope) => queue.enqueue(envelope),
      whenWritable: () => queue.whenWritable(),
    },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  const offered: RunEvent[] = [];
  const terminals: SlowRun['terminals'] = [];
  let turn = 0;
  /** Results waiting for the drain, keyed by callId. */
  const landed: { callId: string; content: string }[] = [];

  const ports: RunEnginePorts = {
    model: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
        turn += 1;
        if (turn > DURABLE_TURNS) {
          yield { type: 'turn_stopped', reason: 'end_turn' };
          return;
        }
        // A tool call, and no text. Each call contributes `tool.call_started`
        // and `tool.call_completed`, both DURABLE, so the queue fills on
        // retained frames rather than on the merge path that is broken.
        for (let index = 0; index < CALLS_PER_TURN; index += 1) {
          yield {
            type: 'tool_use',
            call: {
              callId: `call-${turn}-${index}`,
              name: 'probe',
              input: { value: `v${turn}${index}` },
              sideEffect: 'read_only',
            },
          };
        }
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    },
    tools: {
      dispatch(call): void {
        landed.push({ callId: call.callId, content: `answer-for-${call.callId}` });
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of landed.splice(0, landed.length)) {
          yield {
            kind: 'tool_result',
            callId: item.callId,
            content: item.content,
            isError: false,
            durationMs: 1,
          };
        }
      },
      discard(): void {
        landed.length = 0;
      },
      describe: () => [{ name: 'probe', description: 'scripted probe', inputSchema: {} }],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [{ name: 'probe', description: 'scripted probe', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    // Required since A3-1 (PR #236). See the note in
    // `engine-scenario-turn-behaviour.test.ts`: test dirs are excluded from
    // every tsconfig, so an omitted required member is invisible to the
    // compiler and only shows up as a runtime `failed` run.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
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
    events: {
      publish(event: RunEvent): void {
        offered.push(event);
        // Through the real emitter, which is the binding `buildEnginePorts`
        // uses and the only reason a terminal is held.
        emitter.emit(event);
      },
      proposeTerminal(candidate): void {
        terminals.push({ state: candidate.state as { status: string }, reason: candidate.reason });
      },
    } as RunEventStorePort,
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: DURABLE_TURNS });
  const handle = engine.execute({
    manifest: { runId: RUN_ID, budget: {} } as never,
    input: {
      revision: 'rev-1',
      prompt: { role: 'user', id: 'p1', content: 'go' },
      history: { kind: 'inline', value: [] },
      attachments: { kind: 'inline', value: [] },
      catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
      steering: [],
      options: {},
    } as never,
    signal: new AbortController().signal,
    ports,
  });

  return {
    queue,
    offered,
    terminals,
    // Computed on demand, NOT captured here: this object literal is built
    // before the run has produced anything, so an eager list would be the empty
    // one and the comparison in the test would be vacuously true.
    offeredDurable: () =>
      offered.filter((event) => DURABLE_TYPES.has(event.type)).map((event) => event.type),
    completed: handle.completed(),
  };
}

describe('slow consumer: a stopped reader costs the engine its deltas, not its transcript', () => {
  it('keeps every durable frame it published, in order, once the reader returns', async () => {
    const run = startHeldConsumerRun();
    await run.completed;

    // --- POSITIVE EVIDENCE, and the reason the rest is not a vacuous green ---
    //
    // The engine really ran DURABLE_TURNS turns' worth of streaming, and the
    // queue really did go over its bound while nobody was reading. Without both
    // of these, "nothing was lost" would also describe a run that never
    // produced anything.
    expect(run.queue.paused, 'the queue should have gone over its bound').toBe(true);
    expect(run.queue.bytes).toBeGreaterThan(MAX_BYTES);
    // The calls the model really made are the ones under pressure.
    const completedEvents = run.offered.filter((event) => event.type === 'tool.call_completed');
    expect(completedEvents).toHaveLength(DURABLE_TURNS * CALLS_PER_TURN);
    expect(run.queue.metrics.durableRetained).toBeGreaterThan(0);

    // The run still reached a terminal candidate rather than dying on a
    // consumer that stopped reading. A dead run would satisfy every
    // "nothing was lost" assertion below.
    expect(run.terminals).toHaveLength(1);
    expect(run.terminals[0]?.reason).toBe('the run reached its turn ceiling');

    // --- THE CLAIM: no durable frame is lost, and none is reordered ---
    //
    // Two independent sources. Source A is what the ENGINE offered its port;
    // source B is what the QUEUE hands a reader once one arrives. Comparing
    // them is what makes "nothing was lost" a fact about the transport rather
    // than a restatement of what the engine did.
    const readBack: string[] = [];
    // Bounded by the queue's own occupancy rather than by a `done` the queue
    // never produces: it stays open after the run ends, and a `read()` on an
    // empty queue parks forever.
    while (run.queue.frames > 0) {
      const next = await run.queue.read();
      if (next.done === true) break;
      const payload = next.value?.payload as { readonly type?: string } | undefined;
      if (payload?.type !== undefined && DURABLE_TYPES.has(payload.type)) readBack.push(payload.type);
    }
    expect(readBack).toEqual(run.offeredDurable());

    // And specifically: every call the model made comes back to the reader, in
    // the order the engine published it.
    expect(readBack.filter((type) => type === 'tool.call_completed')).toHaveLength(
      DURABLE_TURNS * CALLS_PER_TURN,
    );
  });

  it('the engine cannot pause for a slow consumer, and the port says so', async () => {
    // Not a pass/fail claim about correctness -- a MEASUREMENT, asserted so it
    // cannot be quietly changed into a different number by a later edit.
    //
    // `RunEventStorePort.publish` returns `void` and the engine calls it
    // without awaiting, so there is nowhere for a backpressure await to go. The
    // count below is the engine's own publications, and the queue's occupancy
    // is the queue's own: the two are unrelated numbers, which is the point.
    const run = startHeldConsumerRun();
    await run.completed;

    // The engine published everything it produced, with no regard for the
    // reader. If a future change made the engine await the bound, the queue's
    // occupancy would stop tracking the engine's output and this relationship
    // would change -- which is exactly what a future cutover would want to know.
    const completions = run.offered.filter((event) => event.type === 'tool.call_completed');
    expect(completions).toHaveLength(DURABLE_TURNS * CALLS_PER_TURN);
    // The queue retained all of them: nothing was dropped to make room, which
    // is the "durable frames are retained, never dropped" half of the contract.
    // The count is a floor rather than an equality because the queue also holds
    // the `run.started` this harness emitted before the engine ran.
    expect(run.queue.metrics.droppedFrames).toBe(0);
    expect(run.queue.metrics.durableRetained).toBeGreaterThanOrEqual(completions.length);
  });
});
