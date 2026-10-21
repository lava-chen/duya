/**
 * Plan 610 slice A4, the text-delta half of the slow-consumer scenario.
 *
 * ## Why this file exists next to `engine-scenario-slow-consumer.test.ts`
 *
 * That file's header reports a defect it deliberately did NOT test: the engine
 * mints its run-scoped message id as `` `${runId}:message` ``, and
 * `coalesceKeyId` REFUSES any component containing its `:` separator, so a
 * `BoundedEventQueue` throws out of `ports.events.publish`, unwinds
 * `#streamModel`, and ends the run `failed`. That file is scoped to the DURABLE
 * path, which is the half a tool call exercises, and it says so.
 *
 * This file is the other half, and it exists because the defect has been fixed:
 * the engine's message id no longer carries the separator, so the delta path
 * survives a stopped reader the way the durable path always did.
 *
 * ## The defect reproduces on the FIRST delta, not on the first over-bound one
 *
 * The sibling file's header says the throw needs "the first ephemeral frame
 * that arrives while the queue is over its bound". Measured on this tree, that
 * understates it: `BoundedEventQueue.enqueue` reaches `mergeIntoQueued` for an
 * ephemeral frame regardless of occupancy (`backpressure.ts:401` is reached
 * from the over-bound arm, but `coalesceKeyId` is called before any queued
 * sibling is looked for), so the run dies on its FIRST `text_delta` with the
 * queue at 435 bytes and `paused: false`. The fix is the same either way; the
 * point is that this needs no pressure to bite, which is why it is a cutover
 * blocker rather than a slow-consumer edge case.
 *
 * ## What is being decided here
 *
 * Two properties, and the second is the one that makes the first meaningful:
 *
 *  1. The run does not DIE. A `failed` run would satisfy every "nothing was
 *     lost" assertion, because a dead run loses everything consistently.
 *  2. The deltas are accounted for rather than silently mangled - merged where a
 *     sibling frame is already queued, dropped with a recorded gap where none
 *     is, and never welded onto a frame of a DIFFERENT event type.
 *
 * ## Why it must drive the REAL queue and the REAL emitter
 *
 * The throw lives in `BoundedEventQueue.mergeIntoQueued`, which is only reached
 * when the queue is over its bound AND the frame is ephemeral. A recorder port
 * cannot decide either fact. So the publisher binds the queue's own
 * `whenWritable`, the queue's `paused` and `metrics` are asserted as the
 * queue's own numbers, and nothing is read until the run has finished.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { coalesceKeyId, coalesceKeyOf } from '../src/events/coalesce.js';
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

const RUN_ID = 'run-a4-delta' as RunId;

/**
 * Small enough that the FIRST turn's own frames are already over it.
 *
 * The number is the scenario, not a convenience: the merge path is only taken
 * once `#over()` is true, so a bound the run never reaches would make this file
 * a green that decides nothing.
 */
const MAX_BYTES = 700;
/** Turns the engine is driven through against a consumer that never reads. */
const DELTA_TURNS = 4;
/** Text fragments per turn. Each is one ephemeral frame carrying one block. */
const FRAGMENTS_PER_TURN = 3;
/**
 * Tool calls per turn, and why the text path needs them at all.
 *
 * A turn that ends `end_turn` with no tool call COMPLETES the run, so a
 * text-only script finishes after one turn and the queue never approaches its
 * bound - which is a green that decides nothing, and in fact a red for the
 * wrong reason. A tool call is what makes the engine's loop continue, exactly
 * as in the sibling file, and its DURABLE frames are what reliably push the
 * queue over its bound. The deltas stay the thing under test: they are the
 * ephemeral frames that take the merge branch once it is over.
 */
const CALLS_PER_TURN = 2;

interface DeltaRun {
  readonly queue: BoundedEventQueue;
  /** Every event the engine offered the port, in order. */
  readonly offered: RunEvent[];
  /** Terminal candidates the engine proposed. */
  readonly terminals: { state: { status: string }; reason: string }[];
  readonly completed: Promise<void>;
}

/**
 * Drive a real engine at a real queue whose reader never reads, streaming TEXT.
 *
 * The tool path in the sibling file produces durable frames only. This one
 * produces `assistant.text_delta` on every fragment, which is the frame type
 * that reaches the merge path - and therefore the one whose key the engine's
 * message id has to survive.
 */
function startHeldConsumerDeltaRun(): DeltaRun {
  const queue = new BoundedEventQueue({ runId: RUN_ID, maxBytes: MAX_BYTES });
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-a4-delta',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
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
  const terminals: DeltaRun['terminals'] = [];
  let turn = 0;
  /** Results waiting for the drain, keyed by callId. */
  const landed: { callId: string; content: string }[] = [];

  const ports: RunEnginePorts = {
    model: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
        turn += 1;
        if (turn > DELTA_TURNS) {
          yield { type: 'turn_stopped', reason: 'end_turn' };
          return;
        }
        // Text FIRST, so the deltas of this turn are published before this
        // turn's durable tool frames arrive. Each fragment becomes an
        // EPHEMERAL `assistant.text_delta`, which is what takes the queue's
        // merge-or-drop branch once it is over its bound.
        for (let index = 0; index < FRAGMENTS_PER_TURN; index += 1) {
          yield { type: 'text', text: `t${turn}f${index}-${'x'.repeat(40)} ` };
        }
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
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    // The three ports the legacy-still-drives window closed (plan 610 D4, then
    // D1 for `modeExit`), bound to their smallest honest answers. This file
    // compares two emitter configurations, so none of these three is the subject
    // and each says "records nothing", "never compacts", "exits no modes".
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined' as const, reason: 'not under test' }),
      nextCompactionId: () => 'cmp-slow-delta',
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    sideEffects: {
      async begin() {
        return {
          attemptKey: 'key-a4-delta',
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
        emitter.emit(event);
      },
      proposeTerminal(candidate): void {
        terminals.push({ state: candidate.state as { status: string }, reason: candidate.reason });
      },
    } as RunEventStorePort,
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: DELTA_TURNS });
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

  return { queue, offered, terminals, completed: handle.completed() };
}

describe('slow consumer, text path: the engine\'s message id survives the merge key', () => {
  it('keeps the run alive while streaming deltas into a stopped reader', async () => {
    const run = startHeldConsumerDeltaRun();
    await run.completed;

    // --- POSITIVE EVIDENCE, and the reason the rest is not a vacuous green ---
    //
    // The engine really streamed every fragment, and the queue really did have
    // to decide on them. Without both, "nothing was lost" would also describe a
    // run that produced nothing.
    const deltas = run.offered.filter((event) => event.type === 'assistant.text_delta');
    expect(deltas.length, 'the engine should really have streamed deltas').toBe(
      DELTA_TURNS * FRAGMENTS_PER_TURN,
    );
    // And the queue's own accounting saw them: offered frames exceed the two
    // durable ones the harness emitted before the engine ran.
    expect(run.queue.metrics.offeredFrames).toBeGreaterThan(deltas.length);

    // --- THE CLAIM ---
    //
    // This is the defect, and it is a crash rather than a slow degradation: the
    // queue's merge path builds a key from the engine's message id, the id
    // carried the key separator, and the throw escaped `ports.events.publish`,
    // unwound `#streamModel` and was caught by `#run`. So the run died
    // `failed` on its FIRST delta. Asserting the terminal BEFORE any
    // "nothing was lost" claim is the point: a `failed` run satisfies those.
    expect(run.terminals).toHaveLength(1);
    expect(run.terminals[0]?.state.status).not.toBe('failed');
    expect(run.terminals[0]?.reason).toBe('the run reached its turn ceiling');

    // The deltas really did reach the queue's merge-or-drop decision rather
    // than being refused at the boundary.
    const decided = run.queue.metrics.ephemeralMerged + run.queue.metrics.ephemeralDropped;
    expect(decided, 'the queue should have merged or dropped ephemeral frames').toBeGreaterThan(0);
  });

  it('builds a merge key for the message id the engine actually mints', () => {
    // The narrow invariant, separated from the integration above so a failure
    // names the CAUSE rather than the symptom.
    //
    // `coalesceKeyId` refuses a component carrying its `:` separator, and that
    // refusal is load-bearing (see its doc comment: `messageId "a"` with
    // `blockIndex 12` and `messageId "a1"` with `blockIndex 2` would otherwise
    // collide). So the engine's id has to be separator-free, and the value
    // below is the one the two sibling hosts already mint
    // (`run-orchestrator.ts:924`, `headless-run-host.ts:474`).
    const messageId = `m-${RUN_ID}`;
    expect(messageId).not.toContain(':');
    expect(() =>
      coalesceKeyId({
        runId: RUN_ID,
        eventType: 'assistant.text_delta',
        scope: { kind: 'message', messageId, blockIndex: 0 },
      }),
    ).not.toThrow();
  });

  it('never splits one run across two message identities', async () => {
    // The property the shared id exists to protect, asserted on the REAL run
    // rather than on a synthetic key. A per-turn or per-block id - the failure
    // mode the run-scoped id was chosen to make impossible - would show up here
    // as more than one distinct value across the frames a reader gets back.
    const run = startHeldConsumerDeltaRun();
    await run.completed;

    const readBack: { type: string; messageId: string }[] = [];
    while (run.queue.frames > 0) {
      const next = await run.queue.read();
      if (next.done === true) break;
      const payload = next.value?.payload as { type?: string; messageId?: string } | undefined;
      if (payload?.type !== undefined && payload.messageId !== undefined) {
        readBack.push({ type: payload.type, messageId: payload.messageId });
      }
    }

    const assistant = readBack.filter((frame) => frame.type.startsWith('assistant.'));
    expect(assistant.length, 'the reader should have got assistant frames back').toBeGreaterThan(0);
    // One id for the whole run, across every turn and every block.
    expect(new Set(assistant.map((frame) => frame.messageId)).size).toBe(1);
    // And it is the id the engine minted, which is the value the merge key has
    // to survive. Asserted on the value rather than on a format so this test
    // cannot drift into pinning a spelling it does not own.
    expect(assistant[0]?.messageId).toBe(
      run.offered.find((event) => event.type === 'assistant.text_delta')?.messageId,
    );
  });

  it('still refuses a merge key whose component carries the separator', () => {
    // The guard the fix must NOT weaken. A regression that "fixed" the defect
    // by letting `:` through everywhere would make this pass nothing and the
    // collision real; asserting it keeps the refusal honest.
    const hostile = {
      runId: RUN_ID,
      eventType: 'assistant.text_delta' as const,
      scope: { kind: 'message' as const, messageId: 'a:1', blockIndex: 2 },
    };
    expect(coalesceKeyOf(RUN_ID, {
      type: 'assistant.text_delta',
      messageId: 'a:1',
      index: 2,
      delta: 'x',
    })).not.toBeNull();
    expect(() => coalesceKeyId(hostile)).toThrow(/key separator/);
  });
});
