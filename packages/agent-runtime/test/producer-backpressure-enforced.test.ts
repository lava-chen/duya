/**
 * G15 (rewritten) - the pause is a pause, or it is not a pause.
 *
 * ## What this replaces
 *
 * `backpressure.test.ts` asserts the queue's side of the contract: that it
 * reports `paused`, that `whenWritable()` resolves when the queue is back in
 * bounds, and that the bytes it holds are reported. All of that is true and all
 * of it is insufficient, because a queue that reports a pause nobody obeys
 * behaves identically to a queue that never went over its bound. The old gate
 * read `paused === true` and called the property proven.
 *
 * The three properties this file is written around, in the order the contract
 * states them:
 *
 *  1. **Continuous production against a consumer that stopped reading keeps
 *     memory bounded.** Not "reports that it is over its bound" - bounded. The
 *     producer here offers 200 durable frames, which is roughly 150x the byte
 *     bound, and the queue's occupancy has to stay near the bound.
 *  2. **Production resumes afterwards, and nothing durable is lost.** The
 *     producer is not abandoned at the pause and it does not come back with a
 *     hole: every frame it minted reaches the reader, in order.
 *  3. **`whenWritable()` is awaited by a real producer.** The producer is a loop
 *     over the real {@link RunEventEmitter.publish}, and the assertion is that
 *     the loop STOPS ADVANCING while the reader is held - the model loop's own
 *     progress, measured in frames minted, not the queue's opinion of itself.
 *
 * ## Why the assertion is "frames minted", not "paused"
 *
 * A flag the queue sets about itself cannot distinguish a producer that stopped
 * from a producer that is about to. The count of frames the producer has minted
 * can: if the await is removed from `publish`, this producer runs to completion
 * during the hold and every assertion below fails on a number rather than
 * hanging. MUTATION PROVEN - see the run recorded in the commit message.
 *
 * ## The control channel
 *
 * The pause is scoped to the event queue and cannot be reached from the control
 * path: `publish` waits on the publisher's own bound and `permission.respond` /
 * `run.cancel` never call it. `control-channel-not-starved.test.ts` is the test
 * of that boundary and it is run alongside this one; nothing here re-asserts it,
 * because duplicating a boundary test is how a boundary test rots.
 */

import { describe, expect, it } from 'vitest';
import type { RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';
import { BoundedEventQueue, defaultEnvelopeBytes } from '../src/events/backpressure.js';
import { RunEventEmitter, type EventPublisher } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';

const RUN_ID = 'run-backpressure';
const MAX_BYTES = 400;
/** How many durable frames the producer offers if nothing ever stops it. */
const TOTAL_FRAMES = 200;
/** Ticks of the event loop a held reader is given to prove the producer is parked. */
const HOLD_TICKS = 50;

interface ProducerRun {
  readonly queue: BoundedEventQueue;
  readonly emitter: RunEventEmitter;
  /** Frames the producer has actually minted so far. Read while it is parked. */
  readonly produced: () => number;
  /** Resolves when the producer has finished, having emitted all it was asked to. */
  readonly finished: Promise<void>;
  /** Reads one frame; resolves as soon as the queue yields one. */
  readonly next: () => Promise<RunEventEnvelope>;
}

/**
 * A real producer over the real emitter and a real bounded queue.
 *
 * The publisher is the one production shape a queue can take: `push` plus
 * `whenWritable`. It is written here rather than reused from `RunEventStream`
 * so this test does not depend on that class's constructor, and so the thing
 * under test is the emitter's arm and the queue's bound rather than a stream's
 * plumbing.
 */
function startProducer(): ProducerRun {
  const queue = new BoundedEventQueue({ runId: RUN_ID, maxBytes: MAX_BYTES });
  const publisher: EventPublisher = {
    push: (envelope: RunEventEnvelope): void => {
      queue.enqueue(envelope);
    },
    whenWritable: (): Promise<void> => queue.whenWritable(),
  };

  const persistence: RunPersistence = {
    append: async () => undefined,
    complete: async (_terminal: RunTerminalState, _metrics: RunMetrics) => undefined,
  };
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-backpressure',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const emitter = new RunEventEmitter({ session, stream: publisher, runId: RUN_ID });

  let minted = 0;
  const finished = (async () => {
    for (let index = 0; index < TOTAL_FRAMES; index += 1) {
      const result = await emitter.publish({
        type: 'assistant.text_block',
        messageId: 'msg-1',
        index,
        // Big enough that a handful of frames fill the bound, so "bounded" is a
        // property of the pause rather than of the frame size.
        text: 'x'.repeat(200),
      });
      if (!result.ok) throw new Error(`producer frame ${index} was refused: ${result.code}`);
      minted += 1;
    }
  })();

  return {
    queue,
    emitter,
    produced: () => minted,
    finished,
    next: async () => {
      const result = await queue.read();
      if (result.done === true) throw new Error('the queue closed before the producer finished');
      if (result.value === undefined) throw new Error('the queue yielded no frame');
      return result.value;
    },
  };
}

/** Lets pending microtasks and one macrotask boundary go by, `ticks` times. */
async function tick(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe('a producer that awaits the pause stops advancing, and memory stays bounded', () => {
  it('stops minting under a held reader, resumes, and loses no durable frame', async () => {
    const run = startProducer();
    const { queue } = run;

    // --- The hold: production is continuous, the consumer is not reading. ---
    await tick(HOLD_TICKS);

    const mintedWhileHeld = run.produced();
    const bytesWhileHeld = queue.bytes;

    // The producer is PARKED, not merely slow. This is the assertion the old
    // gate could not make: a loop that ignored the pause would have minted all
    // 200 frames inside these 50 ticks, and a loop that is polling `paused`
    // would have minted them too.
    expect(queue.paused).toBe(true);
    expect(mintedWhileHeld).toBeLessThan(10);
    expect(mintedWhileHeld).toBeGreaterThan(0);

    // Holding the reader for 50 more ticks changes nothing at all: no frame is
    // minted, and not one byte is added to the queue. This is the bounded-memory
    // property, asserted as an absence of growth rather than as a number the
    // queue chose to report about itself.
    await tick(HOLD_TICKS);
    expect(run.produced()).toBe(mintedWhileHeld);
    expect(queue.bytes).toBe(bytesWhileHeld);

    // And the bound is still a bound: the occupancy is within one frame of it,
    // not within 150 frames of it. One frame of slack is the documented policy -
    // a durable frame is admitted even when it tips the queue over, rather than
    // being dropped to stay under.
    const oneFrame = defaultEnvelopeBytes({
      runId: RUN_ID,
      sessionId: 'sess-backpressure',
      seq: 1,
      timestamp: 1_000,
      traceId: 'trace-1',
      payload: {
        type: 'assistant.text_block',
        messageId: 'msg-1',
        index: 0,
        text: 'x'.repeat(200),
      },
    } as unknown as RunEventEnvelope);
    expect(bytesWhileHeld).toBeLessThanOrEqual(MAX_BYTES + oneFrame);
    expect(queue.metrics.durableRetained).toBe(mintedWhileHeld);
    expect(queue.metrics.droppedFrames).toBe(0);

    // --- The resume: the consumer reads, and the producer moves again. ---
    const received: RunEventEnvelope[] = [];
    while (run.produced() < TOTAL_FRAMES) {
      received.push(await run.next());
    }
    await run.finished;
    // Whatever was already buffered when the reader started is drained too.
    while (queue.frames > 0) {
      received.push(await run.next());
    }

    // Production resumed and finished rather than being abandoned at the pause.
    expect(run.produced()).toBe(TOTAL_FRAMES);
    expect(received).toHaveLength(TOTAL_FRAMES);

    // Nothing durable was lost, and nothing was lost silently: every frame the
    // producer minted reached the reader.
    expect(queue.metrics.durableRetained).toBe(TOTAL_FRAMES);
    expect(queue.metrics.droppedFrames).toBe(0);
    expect(queue.gaps.filter((gap) => gap.contentLost)).toHaveLength(0);

    // Order held, and - the reason `publish` waits BEFORE `emit` rather than
    // after it - the seqs are dense. A producer that parked after minting would
    // have burned numbers for frames the consumer never saw, which is a hole in
    // a live stream that no replay can close.
    expect(received.map((frame) => frame.seq)).toEqual(
      Array.from({ length: TOTAL_FRAMES }, (_, i) => i + 1),
    );
  });
});
